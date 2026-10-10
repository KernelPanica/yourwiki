"""Save PDF.js output as a separate artifact, never over the base PDF.

The current layer format is a derived PDF retaining PDF.js native annotations
and form values, rather than a portable semantic annotation JSON format. This
preserves round trips using PDF.js without relying on its private editor state.
Old artifacts are retained when a new version is published; they are not file
history and are deliberately never written over after an uncertain provider call.
"""
import hashlib
import uuid

from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.utils import timezone

from .models import Document, SaveSession
from .pdf_models import PdfAnnotationLayer
from .services import Conflict, require
from .storage import StorageError, active_storage

CONFLICT = 'The PDF original or annotation layer changed. Download your edits before reloading.'


def layer_state(document, raw=None, *, adapter=None):
    adapter = adapter or active_storage()
    raw = adapter.read(document.reference) if raw is None else raw
    layer = PdfAnnotationLayer.objects.filter(document=document).first()
    if layer and layer.base_digest != adapter.fingerprint(document.reference, raw):
        return 'conflict'
    return 'saved'


def saved_pdf(document, *, earlier_annotations=False):
    adapter = active_storage()
    raw = adapter.read(document.reference)
    layer = PdfAnnotationLayer.objects.filter(document=document).first()
    if not layer or (not earlier_annotations and layer.base_digest != adapter.fingerprint(document.reference, raw)):
        return raw
    content = adapter.read(layer.reference)
    if hashlib.sha256(content).hexdigest() != layer.content_digest:
        raise StorageError('The saved PDF annotation artifact changed. Download the original instead.')
    return content


def commit_layer(session_id, *, replace_stale_layer=False):
    """Recheck current access and base identity before publishing a new layer."""
    try:
        with transaction.atomic():
            session = SaveSession.objects.select_for_update().select_related('author').get(pk=session_id)
            document = Document.objects.select_for_update().get(pk=session.document_id)
            if not session.author:
                raise PermissionDenied
            require(document, session.author, 'write')
            require(document, session.author, 'read')
            if session.state == 'saved':
                return session.saved_revision
            if session.state == 'conflict':
                raise Conflict(CONFLICT)
            adapter = active_storage()
            from .source import check_available
            check_available(document)
            base = adapter.read(document.reference)
            fingerprint = adapter.fingerprint(document.reference, base)
            if (session.base_revision != document.revision or session.base_etag != fingerprint
                    or document.storage_digest != fingerprint):
                raise Conflict(CONFLICT)
            layer = PdfAnnotationLayer.objects.filter(document=document).first()
            if layer and layer.base_digest != fingerprint and not replace_stale_layer:
                raise Conflict(CONFLICT)
            content = bytes(session.payload)
            # A unique sibling on the same logical mount. No base reference is
            # passed to write, including when retrying an uncertain response.
            location = adapter.location(document.reference)
            directory = location.rpartition('/')[0]
            key = f'{directory + "/" if directory else ""}.yourwiki-pdf-{document.pk}-{uuid.uuid4().hex}.pdf'
            reference = adapter.write(key, content)
            # Provider calls may be slow; don't publish against a replaced base.
            fresh = Document.objects.get(pk=document.pk)
            require(fresh, session.author, 'write')
            require(fresh, session.author, 'read')
            if adapter.fingerprint(document.reference, adapter.read(document.reference)) != fingerprint:
                raise Conflict(CONFLICT)
            document.revision += 1
            PdfAnnotationLayer.objects.update_or_create(document=document, defaults={
                'base_digest': fingerprint, 'reference': reference,
                'content_digest': hashlib.sha256(content).hexdigest(), 'revision': document.revision})
            document.updated_at = timezone.now()
            document.save(update_fields=['revision', 'updated_at'])
            session.state = 'saved'
            session.saved_revision = document.revision
            session.payload = b''
            session.error = ''
            session.save(update_fields=['state', 'saved_revision', 'payload', 'error', 'updated_at'])
            return document.revision
    except Exception as error:
        state = 'conflict' if isinstance(error, Conflict) else 'denied' if isinstance(error, PermissionDenied) else 'failed'
        message = CONFLICT if state == 'conflict' else 'Write access was revoked.' if state == 'denied' else 'Annotation storage is unavailable. Your pending edits are retained.'
        SaveSession.objects.filter(pk=session_id).update(state=state, error=message)
        raise
