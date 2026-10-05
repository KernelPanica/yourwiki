"""Optional provider-side history; revision counters remain concurrency tokens."""
import base64
import json
import logging
from django.utils import timezone
from .file_formats import digest, encode
from .storage import active_storage, bounded, StorageError, HISTORY_MAX_BYTES


def persist(document, content, key, *, new=False, adapter=None):
    from .services import Conflict
    adapter = adapter or active_storage()
    data = bounded(encode(document, content))
    reference = None if new else document.reference
    previous = None if new else adapter.read(reference)
    if not new and document.storage_digest and adapter.fingerprint(reference, previous) != document.storage_digest:
        raise Conflict('The original file changed in storage. Reload it before saving; your edits have not overwritten it.')
    original_history = document.history_reference
    previous_history = None
    history_written = False
    moved = []
    created_history = None
    try:
        if not new and document.history_enabled() and previous != data:
            try:
                previous_history = adapter.read(original_history, limit=HISTORY_MAX_BYTES) if original_history else None
                history = json.loads(previous_history) if previous_history is not None else {'format': 'yourwiki-history', 'version': 1, 'entries': []}
                if history.get('format') != 'yourwiki-history' or not isinstance(history.get('entries'), list):
                    raise ValueError()
                if not history['entries'] or history['entries'][-1]['sha256'] != digest(previous):
                    history['entries'].append({'saved_at': timezone.now().isoformat(), 'revision': document.revision,
                        'sha256': digest(previous), 'content_base64': base64.b64encode(previous).decode()})
            except (ValueError, KeyError, TypeError, AttributeError):
                raise StorageError('Invalid file history. Save cancelled to protect existing history.') from None
            # ponytail: one bounded history file; archive it when the 50 MiB limit is reached.
            payload = json.dumps(history, ensure_ascii=False).encode()
            if len(payload) > HISTORY_MAX_BYTES:
                raise StorageError('File history exceeds 50 MB. Download and archive the history, then disable history to continue saving. The original was not overwritten.')
            document.history_reference = adapter.write(key + '.json', payload, original_history or None, limit=HISTORY_MAX_BYTES)
            history_written = True
            if not original_history:
                created_history = document.history_reference
        for field, target in [('reference', key), ('history_reference', key + '.json')]:
            ref = reference if field == 'reference' else document.history_reference
            if not ref: continue
            old_key = adapter.location(ref)
            if old_key != target:
                ref = adapter.move(ref, target)
                moved.append((ref, old_key))
                if field == 'reference': reference = ref
                else: document.history_reference = ref
        reference = adapter.write(key, data, reference)
    except Exception:
        for ref, old_key in reversed(moved):
            try:
                adapter.move(ref, old_key)
            except Exception:
                logging.getLogger('wiki').exception('File move rollback failed for %s', document.pk)
        try:
            if created_history:
                adapter.delete(created_history)
            elif history_written and previous_history is not None:
                adapter.write(key + '.json', previous_history, original_history, limit=HISTORY_MAX_BYTES)
        except Exception:
            logging.getLogger('wiki').exception('File history rollback failed for %s', document.pk)
        document.history_reference = original_history
        raise
    document.storage_digest = adapter.fingerprint(reference, data)
    return reference
