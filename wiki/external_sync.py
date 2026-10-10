"""Read provider originals on a bounded heartbeat, preserving unsaved work."""
import time
import uuid
from django.db import transaction
from django.utils import timezone
from .models import Document, Collaboration, SaveSession, SiteConfiguration
from .storage import active_storage

INTERVAL = 30
_checked = {}


def refresh(document_id, *, force=False):
    now = time.monotonic()
    key = str(document_id)
    if not force and now - _checked.get(key, -INTERVAL) < INTERVAL:
        return False
    _checked[key] = now
    # Bound the process cache even when files are repeatedly created/deleted.
    if len(_checked) > 10000:
        for item, checked in list(_checked.items()):
            if now - checked > INTERVAL * 2:
                _checked.pop(item, None)
    original = Document.objects.get(pk=document_id)
    from .source import check_available
    check_available(original)
    adapter = active_storage()
    raw = adapter.read(original.reference)
    fingerprint = adapter.fingerprint(original.reference, raw)
    if fingerprint == original.storage_digest:
        return False
    from .file_formats import decode
    from .services import validate_content
    content = decode(original, raw) if original.kind != 'file' else raw
    validate_content(original.kind, content, SiteConfiguration.current().document_limit_mb)
    with transaction.atomic():
        document = Document.objects.get(pk=document_id)
        # A wiki save or move completed while the provider read was in flight.
        if document.reference != original.reference or document.storage_digest != original.storage_digest:
            return False
        sessions = SaveSession.objects.filter(document=document).exclude(state='saved')
        room = Collaboration.objects.filter(document=document).first()
        if sessions.exists() or (room and room.sequence != room.synced_sequence):
            from .saves import CONFLICT
            # Unknown provider writes must be reconciled before another decision.
            sessions.exclude(state__in=['unknown', 'denied']).update(state='conflict', error=CONFLICT)
            return False
        if room:
            from .collaboration import seed, derive
            from .native import unpack
            seeded = seed(document, content)
            room.state, room.snapshot = seeded.get_update(), content
            room.sequence += 1
            room.synced_sequence = room.sequence
            room.generation = uuid.uuid4()
            if document.kind == 'table':
                room.saved_structure = unpack(derive(seeded, 'table'))['data'].get('_axes', {})
            room.save()
        document.storage_digest = fingerprint
        if original.storage_digest:
            document.revision += 1
        document.updated_at = timezone.now()
        document.save(update_fields=['storage_digest', 'revision', 'updated_at'])
    return True
