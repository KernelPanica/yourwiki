"""One provider writer and durable, bounded pending editor snapshots."""
import hashlib
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.utils import timezone
from .models import Document, SaveSession, Collaboration
from .services import Conflict, require, storage_key, validate_content
from .storage import active_storage, bounded

CONFLICT = 'The original changed. Automatic saving is paused; copy or download your edits before reloading.'


def write_snapshot(document, content, key, *, user, adapter=None, new=False, raw=False):
    """Shared by source/API, PDF and CRDT flush. Never bypass current ACL."""
    if not new:
        require(Document.objects.get(pk=document.pk), user, 'write')
        if not raw:
            from .collabora import check_available
            check_available(document)
    from .file_history import persist
    return persist(document, content, key, new=new, adapter=adapter or active_storage(),user=user,raw=raw)


@transaction.atomic
def stage(document, user, payload, client_id, base_revision, *, sequence=0):
    document = Document.objects.get(pk=document.pk)
    require(document,user,'write')
    if not isinstance(client_id,str) or not client_id or len(client_id)>160:
        raise ValidationError('Invalid save session.')
    if type(base_revision) is not int or not 1<=base_revision<=2147483647:
        raise ValidationError('Invalid base revision.')
    raw=bounded(payload if isinstance(payload,bytes) else payload.encode())
    checksum=hashlib.sha256(raw).hexdigest()
    session=SaveSession.objects.filter(document=document,client_id=client_id).first()
    if session and session.author_id != user.pk and client_id != 'collaboration':
        raise PermissionDenied
    if session and client_id != 'collaboration' and session.base_revision==base_revision:
        if session.payload_hash==checksum:
            return session
        if session.state in ('saved','conflict','denied'):
            raise Conflict(CONFLICT)
    if session and session.state in ('conflict','unknown'):
        # Keep new CRDT edits for recovery, but never implicitly clear a conflict.
        session.payload=raw;session.payload_hash=checksum;session.sequence=sequence
        session.save(update_fields=['payload','payload_hash','sequence','updated_at'])
        return session
    values={'author':user,'base_revision':base_revision,'base_etag':document.storage_digest,
            'payload':raw,'payload_hash':checksum,'sequence':sequence,'state':'pending','error':'','saved_revision':None}
    session,_=SaveSession.objects.update_or_create(document=document,client_id=client_id,defaults=values)
    return session


def commit(session_id, *, adapter=None):
    # Catch outside the write transaction: failed/conflicting payload must survive.
    try:
        with transaction.atomic():
            session=SaveSession.objects.select_related('document','author').get(pk=session_id)
            document=session.document
            if not session.author:
                raise PermissionDenied
            require(document,session.author,'write')
            if session.state=='saved':return document
            if session.state=='conflict':
                raise Conflict(session.error or CONFLICT)
            if session.base_etag != document.storage_digest:
                raise Conflict(CONFLICT)
            collaborative=session.client_id=='collaboration'
            if not collaborative and document.revision != session.base_revision:
                raise Conflict(CONFLICT)
            from .source import check_available
            check_available(document)
            content=bytes(session.payload) if document.kind=='file' else bytes(session.payload).decode()
            from .models import SiteConfiguration
            validate_content(document.kind,content,SiteConfiguration.current().document_limit_mb)
            from .native import unpack
            if not document.file_format and document.kind in ('document','table'):
                document.file_format='md' if document.kind=='document' else 'ods'
            key=storage_key(document,extension='wiki.json' if document.kind!='file' and not document.file_format and unpack(content) else None)
            document.reference=write_snapshot(document,content,key,user=session.author,adapter=adapter)
            document.path_synced=True
            if not collaborative:document.revision+=1
            document.updated_at=timezone.now()
            document.save(update_fields=['reference','storage_digest','history_reference','path_synced','revision','updated_at','file_format'])
            from .write_journal import acknowledge
            acknowledge(document)
            session.state='saved';session.error='';session.saved_revision=document.revision;session.payload=b''
            session.save(update_fields=['state','error','saved_revision','payload','updated_at'])
            if collaborative:
                if document.kind == 'table':
                    structure = (unpack(content) or {}).get('data', {}).get('_axes', {})
                    Collaboration.objects.filter(document=document).update(saved_structure=structure)
                Collaboration.objects.filter(document=document,sequence=session.sequence).update(synced_sequence=session.sequence)
            return document
    except Exception as error:
        from .write_journal import WriteUncertain
        from .storage import StorageRejected
        state='unknown' if isinstance(error,WriteUncertain) else 'conflict' if isinstance(error,Conflict) else 'denied' if isinstance(error,PermissionDenied) else 'failed'
        message=str(error) if state=='unknown' else CONFLICT if state=='conflict' else 'Write access was revoked. Download your edits before leaving.' if state=='denied' else 'Storage is unavailable. Your pending changes are retained; retry saving.'
        if isinstance(error, StorageRejected): message=str(error)
        elif isinstance(error, ValidationError): message='; '.join(error.messages)
        SaveSession.objects.filter(pk=session_id).update(state=state,error=message)
        raise


def status(document_id):
    session=SaveSession.objects.filter(document_id=document_id,client_id='collaboration').first()
    return {'save_state':session.state if session else 'saved','save_error':session.error if session else ''}
