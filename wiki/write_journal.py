"""Durable intent around non-transactional provider writes.

SQLite rollback cannot undo a remote request. This private local journal is
fsynced before dispatch and survives rollback/process exit. A retry reads the
provider first: confirm the intended result, retry only an unchanged baseline,
or stop on conflict. There is deliberately no blind structural replay.
"""
import hashlib
import json
import os
from pathlib import Path
import uuid
from django.conf import settings
from django.db import transaction
from .storage import StorageError, StorageRejected, StorageMissing


class WriteUncertain(StorageError):
    pass


def _directory(document):
    root = Path(settings.DATA_DIR) / 'write-journal'
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    return root / str(document.pk)


def _atomic(path, data):
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        temp.unlink(missing_ok=True)


def _save(directory, meta):
    _atomic(directory / 'intent.json', json.dumps(meta, ensure_ascii=False).encode())


def _load(document):
    directory = _directory(document)
    path = directory / 'intent.json'
    if not path.exists(): return None
    try:
        meta = json.loads(path.read_bytes())
        payload = (directory / meta.get('payload', 'payload')).read_bytes()
        if meta['document'] != str(document.pk) or hashlib.sha256(payload).hexdigest() != meta['digest']:
            raise ValueError()
        return directory, meta, payload
    except (ValueError, KeyError, OSError):
        raise WriteUncertain('The pending write journal could not be verified. Download your edits and contact an administrator.') from None


def _remove(directory, attempt):
    path = directory / 'intent.json'
    if path.exists() and json.loads(path.read_bytes()).get('attempt') == attempt:
        path.unlink()
        for payload in directory.glob('payload*'):
            payload.unlink(missing_ok=True)


def _index(document, meta, state):
    from .models import Document, WriteAttempt
    if Document.objects.filter(pk=document.pk).exists():
        WriteAttempt.objects.update_or_create(pk=meta['attempt'], defaults={
            'document':document, 'state':state, 'expected_fingerprint':meta.get('expected', ''),
            'intended_digest':meta['digest'], 'confirmed_fingerprint':meta.get('confirmed', ''),
            'reference':meta.get('reference') or ''})


def _equivalent(document, actual, intended):
    if actual == intended: return True
    if document.kind == 'file': return False
    from .file_formats import decode
    from .native import unpack
    try:
        left, right = decode(document, actual), decode(document, intended)
        if left == right: return True
        if document.kind != 'table':
            return json.loads(left) == json.loads(right)
        from .sheet_batches import _cells
        a, b = unpack(left)['data'], unpack(right)['data']
        def sheets(book):
            result = []
            for sid in book.get('sheetOrder', book['sheets']):
                sheet = book['sheets'][sid]
                result.append((sheet['name'], sheet['rowCount'], sheet['columnCount'],
                               _cells(book,sheet), sheet.get('mergeData', [])))
            return result
        return sheets(a) == sheets(b)
    except Exception:
        return False


def recover(document, adapter, content):
    """Restore a confirmed write receipt, or authorize retry of an unchanged base."""
    loaded = _load(document)
    if not loaded: return None
    directory, meta, intended = loaded
    from .models import WriteAttempt
    if WriteAttempt.objects.filter(pk=meta['attempt'], document=document, state='acknowledged').exists():
        _remove(directory, meta['attempt'])
        return None
    ref = meta.get('reference')
    if not ref:
        raise WriteUncertain('A creation request has an unknown result. Resolve the pending creation before trying again.')
    actual = adapter.read(ref)
    fingerprint = adapter.fingerprint(ref, actual)
    expected = meta.get('expected')
    if fingerprint == expected and meta.get('state') != 'confirmed':
        # A prior confirmed baseline may have survived only in the journal.
        document.storage_digest = expected
        document.reference = ref
        document.history_reference = meta.get('history_reference', document.history_reference)
        if meta.get('baseline_structure'):
            from .models import Collaboration
            Collaboration.objects.filter(document=document).update(saved_structure=meta['baseline_structure'])
        _remove(directory, meta['attempt'])
        return None
    if (actual != intended if meta.get('operation') == 'raw' else not _equivalent(document, actual, intended)):
        from .services import Conflict
        raise Conflict('The original changed after an uncertain write. Copy or download your edits before explicitly reloading.')
    document.reference = ref
    document.storage_digest = fingerprint
    document.history_reference = meta.get('history_reference', document.history_reference)
    from .models import Collaboration
    if meta.get('result_structure'):
        Collaboration.objects.filter(document=document).update(saved_structure=meta['result_structure'])
    meta.update(state='confirmed', confirmed=fingerprint)
    _save(directory, meta)
    _index(document, meta, 'confirmed')
    if hashlib.sha256(content if isinstance(content,bytes) else content.encode()).hexdigest() == meta['content_digest']:
        transaction.on_commit(lambda: _remove(directory, meta['attempt']))
        return ref
    # Confirmed earlier snapshot, newer edits may now be saved against this base.
    return None


def perform(document, user, adapter, key, data, reference, expected, *, content,
            operation='file', previous=None, structure=None):
    from .native import unpack
    directory = _directory(document)
    directory.mkdir(mode=0o700, exist_ok=True)
    meta = {'attempt':str(uuid.uuid4()), 'document':str(document.pk), 'author':user.pk if user else None, 'operation':operation,
            'key':key, 'reference':reference, 'expected':expected or '',
            'digest':hashlib.sha256(data).hexdigest(),
            'content_digest':hashlib.sha256(content if isinstance(content,bytes) else content.encode()).hexdigest(),
            'history_reference':document.history_reference, 'state':'prepared',
            'baseline_structure':structure or {},
            'result_structure':(unpack(content) or {}).get('data', {}).get('_axes', {}) if isinstance(content,str) else {}}
    meta['payload'] = 'payload-' + meta['attempt']
    _atomic(directory / meta['payload'], data)
    _save(directory, meta)
    try:
        ref = (adapter.write_table(key,data,reference,previous,structure=structure) if operation=='table'
               else adapter.write(key,data,reference))
        meta['reference'] = ref
        _save(directory, meta)
        meta.update(confirmed=adapter.fingerprint(ref,data), state='confirmed')
        _save(directory, meta)
        _index(document, meta, 'confirmed')
        transaction.on_commit(lambda: _remove(directory, meta['attempt']))
        return ref
    except Exception as error:
        from .services import Conflict
        if isinstance(error, (StorageRejected, Conflict)):
            _remove(directory, meta['attempt'])
            raise
        # Even a timeout can arrive after a successful provider commit.
        if meta['state'] == 'prepared':
            meta['state'] = 'unknown'
            _save(directory, meta)
        raise WriteUncertain('The storage write result is unknown. Your edits are retained. Retry saving to verify the original before another write.') from error


def discard(document):
    """Only explicit reload/discard may abandon a pending intent."""
    loaded = _load(document)
    if loaded:
        directory, meta, _ = loaded
        transaction.on_commit(lambda: _remove(directory, meta['attempt']))
    path = _directory(document) / 'moves.json'
    transaction.on_commit(lambda: path.unlink(missing_ok=True))


def acknowledge(document):
    """Record the receipt in the same SQL transaction as the catalog update."""
    loaded = _load(document)
    if loaded:
        _, meta, _ = loaded
        _index(document, meta, 'acknowledged')
    path = _directory(document) / 'moves.json'
    transaction.on_commit(lambda: path.unlink(missing_ok=True))


def prepare_move(document, adapter, reference, key, field):
    """Journal path identity before rename, including a lost rename response."""
    from .storage import MountedStorage, GoogleDrive, OneDrive
    target = key
    if isinstance(adapter, MountedStorage):
        mount, relative = adapter.resolve(key)
        source, ref = adapter.reference(reference)
        target = ref if source.provider in ('google','onedrive') else relative
        if mount.path != '/': target = f'mount:{mount.pk}:{target}'
    elif isinstance(adapter, (GoogleDrive, OneDrive)):
        target = reference
    raw = adapter.read(reference, limit=None)
    directory = _directory(document)
    directory.mkdir(mode=0o700, exist_ok=True)
    path = directory / 'moves.json'
    moves = json.loads(path.read_bytes()) if path.exists() else []
    moves.append({'source':reference, 'target':target, 'field':field,
                  'digest':hashlib.sha256(raw).hexdigest()})
    _atomic(path, json.dumps(moves).encode())


def recover_moves(document, adapter):
    path = _directory(document) / 'moves.json'
    if not path.exists(): return
    pending = _load(document)
    if pending:
        from .models import WriteAttempt
        if WriteAttempt.objects.filter(pk=pending[1]['attempt'], document=document, state='acknowledged').exists():
            path.unlink()
            return
    from .services import Conflict
    for move in json.loads(path.read_bytes()):
        selected = None
        for ref in dict.fromkeys((move['source'], move['target'])):
            try: raw = adapter.read(ref, limit=None)
            except (StorageMissing, FileNotFoundError): continue
            except (StorageError, OSError):
                raise WriteUncertain('The pending rename could not be verified. Retry when storage is available.') from None
            if hashlib.sha256(raw).hexdigest() == move['digest']:
                selected = ref
                break
            if ref == move['source'] and ref != move['target']:
                raise Conflict('The original at the old path changed. Resolve the pending rename before saving.')
        if not selected:
            # A subsequent write intent can explain changed bytes at the target.
            pending = _load(document)
            if pending and pending[1].get('reference') == move['target']:
                selected = move['target']
            else:
                raise Conflict('The renamed original changed. Download your edits before resolving the pending move.')
        setattr(document, move['field'], selected)
        if move['field'] == 'reference' and selected == move['target']:
            if not _load(document): document.storage_digest = adapter.fingerprint(selected, raw)
