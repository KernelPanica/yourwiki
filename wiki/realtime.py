"""Single-process ASGI transport; SQLite is the durable source of truth."""
import asyncio
import base64
import json
import logging
import re
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
from .services import require, cleanup_storage

log = logging.getLogger('wiki')
connections = {}


def authenticate(scope, doc_id):
    close_old_connections()
    headers = dict(scope.get('headers', []))
    if headers.get(b'origin',b'').decode() != settings.PUBLIC_URL:
        raise ValueError('Origin denied')
    cookies = SimpleCookie(); cookies.load(headers.get(b'cookie',b'').decode())
    cookie = cookies.get(settings.SESSION_COOKIE_NAME)
    session = import_module(settings.SESSION_ENGINE).SessionStore(session_key=cookie.value if cookie else None)
    user = get_user_model().objects.get(pk=session.get('_auth_user_id'), is_active=True)
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
    return {'type':'state','update':base64.b64encode(bytes(room.state)).decode(),'sequence':room.sequence,'synced_sequence':room.synced_sequence}


async def maintenance():
    while True:
        try:
            ids = await sync_to_async(lambda: list(Collaboration.objects.exclude(sequence=0).values_list('document_id',flat=True)))()
            for doc_id in ids:
                try:
                    await sync_to_async(flush_room, thread_sensitive=False)(doc_id)
                except Exception:
                    log.warning('Storage synchronization deferred for document %s', doc_id)
            await sync_to_async(cleanup_storage)()
        except Exception:
            log.warning('Storage maintenance deferred')
        from .models import SiteConfiguration
        interval = await sync_to_async(lambda: SiteConfiguration.current().sync_interval_seconds)()
        await asyncio.sleep(interval)


async def application(scope, receive, send):
    if scope['type'] == 'lifespan':
        worker = None
        while True:
            event = await receive()
            if event['type'] == 'lifespan.startup':
                worker = asyncio.create_task(maintenance())
                await send({'type':'lifespan.startup.complete'})
            elif event['type'] == 'lifespan.shutdown':
                if worker: worker.cancel()
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
    try:
        while True:
            user, writable = await sync_to_async(authenticate)(scope,doc_id)
            state = await sync_to_async(load_state)(doc_id)
            state['write'], state['peers'] = writable, list(peers.values())
            if last != (state['sequence'],state['synced_sequence'],writable,tuple(peers.values())):
                await send({'type':'websocket.send','text':json.dumps(state)})
                last = (state['sequence'],state['synced_sequence'],writable,tuple(peers.values()))
            done, _ = await asyncio.wait([pending], timeout=.4)
            if not done: continue
            event = pending.result()
            if event['type'] == 'websocket.disconnect': break
            if len(event.get('text','')) > 9*1024*1024: raise ValueError('Oversized update')
            data = json.loads(event.get('text','{}'))
            if data.get('type') == 'update':
                if not writable: raise ValueError('Write denied')
                try:
                    sequence = await sync_to_async(apply_update)(user,doc_id,data['update'])
                    await send({'type':'websocket.send','text':json.dumps({'type':'ack','id':data.get('id'),'sequence':sequence})})
                except ValidationError as error:
                    await send({'type':'websocket.send','text':json.dumps({'type':'rejected','id':data.get('id'),'message':'; '.join(error.messages)})})
            elif data.get('type') == 'save':
                try:
                    await sync_to_async(flush_room, thread_sensitive=False)(doc_id)
                    await send({'type':'websocket.send','text':json.dumps({'type':'saved'})})
                except Exception:
                    await send({'type':'websocket.send','text':json.dumps({'type':'error','message':'Saved locally. Storage is unavailable; synchronization will retry.'})})
            pending = asyncio.create_task(receive())
    except Exception:
        await send({'type':'websocket.close','code':1011,'reason':'Server error'})
    finally:
        pending.cancel()
        peers.pop(key,None)
        if not peers: connections.pop(doc_id,None)
