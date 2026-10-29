"""Durable Google Drive trash receipts and detection of provider-side restore."""
import logging
import threading
from django.db import transaction
from django.core.exceptions import ValidationError
from .services import Conflict
from django.utils import timezone
from .models import Document, Folder, ProviderTrashState, TrashEntry, User
from .storage import MountedStorage, mount_adapter, StorageError

log = logging.getLogger(__name__)
lock = threading.RLock()


def enqueue(documents):
    storage = MountedStorage()
    ids = []
    for document in documents:
        mount, reference = storage.reference(document.reference)
        if mount.provider != 'google':
            continue
        ProviderTrashState.objects.update_or_create(document=document,
            defaults={'mount':mount,'reference':reference,'confirmed':False,'error':''})
        ids.append(document.pk)
    if ids:
        from .provider_grants import synchronize_after_commit
        synchronize_after_commit()


def synchronize(ids=None):
    # Per-document durable receipt survives network errors and process restarts.
    with lock:
        for doc in Document.all_objects.filter(trash__isnull=False, provider_trash__isnull=True):
            mount, reference = MountedStorage().reference(doc.reference)
            if mount.provider == 'google':
                ProviderTrashState.objects.get_or_create(document=doc, defaults={'mount':mount,'reference':reference})
        rows = ProviderTrashState.objects.filter(document__trash__isnull=False).select_related('mount')
        if ids is not None:
            rows = rows.filter(document_id__in=ids)
        for row in rows:
            try:
                with transaction.atomic():
                    current = ProviderTrashState.objects.filter(pk=row.pk, document__trash__isnull=False).select_related('mount').first()
                    if current is None:
                        continue
                    row = current
                    adapter = mount_adapter(row.mount)
                    trashed = adapter.trash_state(row.reference)
                    if row.confirmed and not trashed:
                        restore_from_provider(row.document_id)
                        continue
                    if not trashed:
                        adapter.set_trashed(row.reference, True)
                    ProviderTrashState.objects.filter(pk=row.pk).update(confirmed=True,error='',checked_at=timezone.now())
            except (Conflict, ValidationError) as error:
                ProviderTrashState.objects.filter(pk=row.pk).update(error=str(error),checked_at=timezone.now())
            except Exception:
                ProviderTrashState.objects.filter(pk=row.pk).update(
                    error='Google Drive trash synchronization failed. It will retry automatically.',checked_at=timezone.now())
                log.warning('Provider trash synchronization deferred for document %s', row.document_id)


def untrash_for_restore(entry):
    for row in ProviderTrashState.objects.filter(document__trash=entry).select_related('mount'):
        try:
            adapter = mount_adapter(row.mount)
            if adapter.trash_state(row.reference):
                adapter.set_trashed(row.reference, False)
        except Exception:
            raise StorageError('Google Drive could not restore the original. The file remains in Yourwiki trash; try again.') from None


@transaction.atomic
def restore_from_provider(document_id):
    doc = Document.all_objects.select_related('trash', 'folder').get(pk=document_id)
    if not doc.trash_id:
        return
    entry = doc.trash
    admin = User.objects.filter(is_superuser=True, is_active=True).first()
    if not admin:
        raise StorageError('An active administrator is required to reconcile provider restore.')
    # A provider can restore one file from a removed tree. Return the containing
    # directories, keeping other files in separate trash entries with their ACLs.
    ancestor = doc.folder
    batches = set()
    while ancestor:
        if ancestor.trash_id:
            batches.add(ancestor.trash_id)
        ancestor = ancestor.parent
    for batch in TrashEntry.objects.filter(pk__in=batches):
        for other in Document.all_objects.filter(trash=batch).select_related('folder'):
            from .folders import storage_path
            individual = TrashEntry.objects.create(root_id=other.pk, kind='file', name=other.title,
                original_path=storage_path(other.folder), deleted_at=batch.deleted_at, deleted_by=batch.deleted_by)
            Document.all_objects.filter(pk=other.pk).update(trash=individual)
        Folder.all_objects.filter(trash=batch).update(trash=None)
        batch.delete()
    doc.refresh_from_db()
    from .trash import restore
    restore(admin, doc.trash, provider_restored=True)
