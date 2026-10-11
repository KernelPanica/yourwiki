"""Single-process ASGI transport; SQLite is the durable source of truth."""
import asyncio
import base64
import json
import logging
import re
from datetime import timedelta
from django.utils import timezone
from http.cookies import SimpleCookie
from importlib import import_module
from django.conf import settings
from django.contrib.auth import get_user_model, HASH_SESSION_KEY
from django.db import close_old_connections
from django.core.exceptions import ValidationError
from django.utils.crypto import constant_time_compare
from asgiref.sync import sync_to_async
from .models import Collaboration, Document
from .collaboration import apply_update, flush_room
from .services import require, cleanup_storage, Conflict
from .presence import touch as touch_presence, list_active, remove as remove_presence, expire as expire_presence
from .write_journal import WriteUncertain

log = logging.getLogger('wiki')
connections = {}
presence_connections = {}


def authenticate(scope, doc_id):
    close_old_connections()
    headers = dict(scope.get('headers', []))
    if headers.get(b'origin',b'').decode() != settings.PUBLIC_URL:
        raise ValueError('Origin denied')
    cookies = SimpleCookie(); cookies.load(headers.get(b'cookie',b'').decode())
    cookie = cookies.get(settings.SESSION_COOKIE_NAME)
    session = import_module(settings.SESSION_ENGINE).SessionStore(session_key=cookie.value if cookie else None)
    user = get_user_model().objects.get(pk=session.get('_auth_user_id'), is_active=True)
    if user.provider_setup_required:
        raise ValueError('Provider setup required')
    if not constant_time_compare(session.get(HASH_SESSION_KEY, ''), user.get_session_auth_hash()):
        raise ValueError('Session expired')
    doc = Document.objects.get(pk=doc_id)
    require(doc,user,'read')
    from .source import check_available
    check_available(doc)
    return user, doc.allows(user,'write')


def load_state(doc_id):
    close_old_connections()
    room = Collaboration.objects.get(document_id=doc_id)
    from .saves import status as save_status
    return {**save_status(doc_id), 'generation':str(room.generation), 'type':'state','update':base64.b64encode(bytes(room.state)).decode(),'sequence':room.sequence,'synced_sequence':room.synced_sequence}


async def maintenance():
    sweep = iter(())
    while True:
        try:
            from .external_sync import refresh
            # Active editors first; idle files advance through a bounded sweep.
            for doc_id in list(connections):
                try:
                    await sync_to_async(refresh, thread_sensitive=False)(doc_id)
                except Exception:
                    log.warning('External synchronization deferred for document %s', doc_id)
            batch = []
            for _ in range(10):
                candidate = next(sweep, None)
                if candidate is None:
                    sweep = iter(await sync_to_async(lambda: list(Document.objects.values_list('pk', flat=True).order_by('pk')))())
                    break
                batch.append(candidate)
            for doc_id in batch:
                try:
                    await sync_to_async(refresh, thread_sensitive=False)(doc_id)
                except Exception:
                    log.warning('External synchronization deferred for document %s', doc_id)
            ids = await sync_to_async(lambda: list(Collaboration.objects.filter(document__trash__isnull=True, updated_at__lte=timezone.now()-timedelta(seconds=1.5)).exclude(sequence=0).exclude(document__save_sessions__state__in=['conflict','denied','unknown']).values_list('document_id',flat=True)))()
            for doc_id in ids:
                try:
                    await sync_to_async(flush_room, thread_sensitive=False)(doc_id)
                except Exception:
                    log.warning('Storage synchronization deferred for document %s', doc_id)
            await sync_to_async(cleanup_storage)()
            await sync_to_async(expire_presence)()
        except Exception:
            log.warning('Storage maintenance deferred')
        from .models import SiteConfiguration
        interval = await sync_to_async(lambda: SiteConfiguration.current().sync_interval_seconds)()
        await asyncio.sleep(interval)


async def application(scope, receive, send):
    if scope['type'] == 'lifespan':
        worker = None
        discovery_worker = None
        while True:
            event = await receive()
            if event['type'] == 'lifespan.startup':
                worker = asyncio.create_task(maintenance())
                from .discovery import discover_sources
                discovery_worker = asyncio.create_task(discover_sources())
                await send({'type':'lifespan.startup.complete'})
            elif event['type'] == 'lifespan.shutdown':
                if worker: worker.cancel()
                if discovery_worker: discovery_worker.cancel()
                await send({'type':'lifespan.shutdown.complete'})
                return
    match = re.fullmatch(r'/ws/documents/([0-9a-f-]{36})/',scope['path'])
    await receive()
    try:
        if not match: raise ValueError()
        doc_id = match.group(1)
        user, writable = await sync_to_async(authenticate)(scope,doc_id)
        await sync_to_async(load_state)(doc_id)
    except Exception:
        if 'websocket.http.response' in scope.get('extensions',{}):
            await send({'type':'websocket.http.response.start','status':500,'headers':[(b'content-type',b'text/plain')]})
            await send({'type':'websocket.http.response.body','body':b'Server error'})
        else:
            await send({'type':'websocket.close','code':1011})
        return
    await send({'type':'websocket.accept'})
    key = id(send)
    peers = connections.setdefault(doc_id,{})
    peers[key] = user.label
    pending = asyncio.create_task(receive())
    last = -1
    last_presence = None
    presence_id = None
    try:
        while True:
            user, writable = await sync_to_async(authenticate)(scope,doc_id)
            state = await sync_to_async(load_state)(doc_id)
            sessions = await sync_to_async(list_active)(doc_id)
            state['write'], state['peers'] = writable, [entry['name'] for entry in sessions]
            if last != (state['generation'],state['sequence'],state['synced_sequence'],state['save_state'],state['save_error'],writable,tuple(state['peers'])):
                await send({'type':'websocket.send','text':json.dumps(state)})
                last = (state['generation'],state['sequence'],state['synced_sequence'],state['save_state'],state['save_error'],writable,tuple(state['peers']))
            presence_signature = json.dumps(sessions, sort_keys=True)
            if presence_signature != last_presence:
                await send({'type':'websocket.send','text':json.dumps({'type':'presence','sessions':sessions})})
                last_presence = presence_signature
            done, _ = await asyncio.wait([pending], timeout=.4)
            if not done: continue
            event = pending.result()
            if event['type'] == 'websocket.disconnect': break
            from .storage import auxiliary_limit_bytes
            cap = await sync_to_async(auxiliary_limit_bytes)(9*1024*1024, 3)
            if cap is not None and len(event.get('text','')) > cap: raise ValueError('Oversized update')
            data = json.loads(event.get('text','{}'))
            if data.get('type') == 'presence':
                try:
                    candidate = data.get('session_id')
                    if presence_id is not None and candidate != presence_id:
                        raise ValidationError('A connection cannot switch presence sessions.')
                    entry = await sync_to_async(touch_presence)(doc_id, user, candidate, data.get('selection', {}))
                    presence_id = entry['id']
                    presence_connections[(doc_id, presence_id)] = key
                except ValidationError as error:
                    await send({'type':'websocket.send','text':json.dumps({'type':'presence-error','message':'; '.join(error.messages)})})
            elif data.get('type') == 'update':
                if not writable: raise ValueError('Write denied')
                try:
                    if not data.get('generation'):
                        raise Conflict('Reload the editor before sending changes.')
                    sequence = await sync_to_async(apply_update)(user,doc_id,data['update'],generation=data.get('generation'))
                    await send({'type':'websocket.send','text':json.dumps({'type':'ack','id':data.get('id'),'sequence':sequence})})
                except ValidationError as error:
                    await send({'type':'websocket.send','text':json.dumps({'type':'rejected','id':data.get('id'),'message':'; '.join(error.messages)})})
                except Conflict as error:
                    await send({'type':'websocket.send','text':json.dumps({'type':'conflict','message':str(error)})})
            elif data.get('type') == 'save':
                if not writable: raise ValueError('Write denied')
                try:
                    await sync_to_async(flush_room, thread_sensitive=False)(doc_id)
                    saved=await sync_to_async(load_state)(doc_id)
                    await send({'type':'websocket.send','text':json.dumps({'type':'saved','sequence':saved['sequence'],'synced_sequence':saved['synced_sequence']})})
                except WriteUncertain as error:
                    await send({'type':'websocket.send','text':json.dumps({'type':'unknown','message':str(error)})})
                except Conflict as error:
                    await send({'type':'websocket.send','text':json.dumps({'type':'conflict','message':str(error)})})
                except Exception:
                    await send({'type':'websocket.send','text':json.dumps({'type':'error','message':'Saved locally. Storage is unavailable; synchronization will retry.'})})
            pending = asyncio.create_task(receive())
    except Exception:
        await send({'type':'websocket.close','code':1011,'reason':'Server error'})
    finally:
        pending.cancel()
        if presence_id and presence_connections.get((doc_id, presence_id)) == key:
            presence_connections.pop((doc_id, presence_id), None)
            try:
                await sync_to_async(remove_presence)(doc_id, user, presence_id)
            except Exception:
                pass  # TTL removes a session if cleanup cannot reach the DB.
        if writable:
            try:
                state = await sync_to_async(load_state)(doc_id)
                if state['save_state'] not in ('unknown', 'conflict', 'denied'):
                    await sync_to_async(flush_room, thread_sensitive=False)(doc_id)
            except Exception:
                pass  # Durable session exposes the failure on the next connection.
        peers.pop(key,None)
        if not peers: connections.pop(doc_id,None)
