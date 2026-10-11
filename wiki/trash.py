"""Admin-only recycle bin. Original provider objects stay intact until purged."""
from django.contrib import messages
from django.utils.translation import gettext as _
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import F
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_http_methods
from .acl import ResourcePermissionDenied
from .models import Document, Folder, TrashEntry, PendingDeletion
from .services import require, Conflict
from .views import guarded


def administrator(user):
    if not user.is_authenticated or not user.is_active or not user.is_superuser:
        raise ResourcePermissionDenied


def subtree(folder):
    folders, documents, pending, seen = [], [], [folder], set()
    while pending:
        node = pending.pop()
        if node.pk in seen:
            raise ValidationError('Invalid directory hierarchy.')
        seen.add(node.pk)
        folders.append(node)
        documents.extend(Document.all_objects.filter(folder=node))
        pending.extend(Folder.all_objects.filter(parent=node))
    return folders, documents


def ensure_no_trashed_descendants(folder):
    folders, documents = subtree(folder)
    if any(item.trash_id for item in folders + documents):
        raise ValidationError('Restore or permanently delete trashed contents before moving this folder.')


def retire_editors(ids):
    from .models import OfficeSession, SaveSession, SourceLease
    OfficeSession.objects.filter(document_id__in=ids).update(superseded=True)
    SaveSession.objects.filter(document_id__in=ids, state__in=['pending', 'unknown']).update(
        state='denied', error='The document was moved to trash. Download or copy your edits.')
    SourceLease.objects.filter(document_id__in=ids).delete()


@transaction.atomic
def trash_document(user, doc):
    from .folders import storage_path
    current = Document.objects.get(pk=doc.pk)
    require(current, user, 'write')
    if current.revision != doc.revision:
        raise Conflict('This document changed. Reload it before deleting.')
    entry = TrashEntry.objects.create(root_id=current.pk, kind='file', name=current.title,
                                      original_path=storage_path(current.folder), deleted_by=user)
    Document.all_objects.filter(pk=current.pk).update(trash=entry, revision=F('revision') + 1)
    retire_editors([current.pk])
    from .cloud_trash import enqueue
    enqueue([current])
    from .provider_grants import synchronize_after_commit
    synchronize_after_commit()
    return entry


@transaction.atomic
def trash_directory(user, folder, directories=None, documents=None):
    from .folders import deletion_contents, storage_path
    folder = Folder.objects.get(pk=folder.pk)
    # Always revalidate inside the transaction, including mounted directories.
    directories, documents = deletion_contents(user, folder)
    entry = TrashEntry.objects.create(root_id=folder.pk, kind='folder', name=folder.name,
                                      original_path=storage_path(folder), deleted_by=user)
    Folder.all_objects.filter(pk__in=[f.pk for f in directories]).update(trash=entry)
    Document.all_objects.filter(pk__in=[d.pk for d in documents]).update(trash=entry, revision=F('revision') + 1)
    retire_editors([d.pk for d in documents])
    from .cloud_trash import enqueue
    enqueue(documents)
    from .provider_grants import synchronize_after_commit
    synchronize_after_commit()
    return entry


@transaction.atomic
def restore(user, entry, *, provider_restored=False):
    administrator(user)
    entry = TrashEntry.objects.get(pk=entry.pk)
    model = Folder if entry.kind == 'folder' else Document
    root = get_object_or_404(model.all_objects, pk=entry.root_id, trash=entry)
    parent = root.parent_policy
    if parent and parent.trash_id:
        raise ValidationError('Restore the parent folder first.')
    if isinstance(root, Folder) and Folder.objects.filter(parent=parent, name__iexact=root.name).exists():
        raise Conflict('A folder with this name already exists. Rename it before restoring.')
    if not provider_restored and isinstance(root, Document) and Document.objects.filter(folder=parent, title__iexact=root.title).exists():
        raise Conflict('A file with this name already exists. Rename it before restoring.')
    if not provider_restored:
        from .cloud_trash import untrash_for_restore
        untrash_for_restore(entry)
    from .models import ProviderTrashState
    ProviderTrashState.objects.filter(document__trash=entry).delete()
    Folder.all_objects.filter(trash=entry).update(trash=None)
    Document.all_objects.filter(trash=entry).update(trash=None)
    entry.delete()
    from .provider_grants import synchronize_after_commit
    synchronize_after_commit()


@transaction.atomic
def purge(user, entry):
    administrator(user)
    entry = TrashEntry.objects.get(pk=entry.pk)
    model = Folder if entry.kind == 'folder' else Document
    root = get_object_or_404(model.all_objects, pk=entry.root_id, trash=entry)
    folders, documents = subtree(root) if isinstance(root, Folder) else ([], [root])
    if any(item.trash_id is None for item in folders + documents):
        raise Conflict('Trash contents changed. Review them again before deleting.')
    ids = [doc.pk for doc in documents]
    references = set()
    for doc in documents:
        references.add(doc.reference)
        if doc.history_reference:
            references.add(doc.history_reference)
        references.update(doc.attachments.values_list('reference', flat=True))
        from .models import PdfAnnotationLayer
        references.update(PdfAnnotationLayer.objects.filter(document=doc).values_list('reference', flat=True))
    for reference in sorted(references):
        if not reference:
            continue
        if Document.all_objects.exclude(pk__in=ids).filter(reference=reference).exists():
            raise ValidationError('An original is also used outside this trash item.')
        PendingDeletion.objects.get_or_create(reference=reference, directory=False)
    if folders:
        from .storage import active_storage
        from .folders import storage_path
        adapter = active_storage()
        for folder in reversed(folders):
            mount, relative = adapter.resolve(storage_path(folder))
            reference = relative if mount.path == '/' else f'mount:{mount.pk}:{relative}'
            PendingDeletion.objects.get_or_create(reference=reference, directory=True)
    batches = {item.trash_id for item in folders + documents}
    Document.all_objects.filter(pk__in=ids).delete()
    for folder in reversed(folders):
        folder.delete()
    TrashEntry.objects.filter(pk__in=batches).delete()
    from .provider_grants import synchronize_after_commit
    synchronize_after_commit()
    from .services import cleanup_storage
    transaction.on_commit(cleanup_storage)


@guarded
@require_http_methods(['GET'])
def index(request):
    administrator(request.user)
    from .models import ProviderTrashState
    return render(request, 'wiki/trash.html', {'entries': TrashEntry.objects.select_related('deleted_by'),
        'cloud_pending': ProviderTrashState.objects.filter(confirmed=False).count(),
        'cloud_errors': list(ProviderTrashState.objects.exclude(error='').values_list('error',flat=True).distinct()), 'section': 'Trash'})


@guarded
@require_http_methods(['GET', 'POST'])
def manage(request, id):
    administrator(request.user)
    entry = get_object_or_404(TrashEntry, pk=id)
    if request.method == 'POST':
        action = request.POST.get('action')
        if action == 'restore':
            restore(request.user, entry)
            messages.success(request, _('Restored with its original permissions.'))
        elif action == 'purge' and request.POST.get('confirm') == 'on':
            purge(request.user, entry)
            messages.success(request, _('Permanently deleted. Unfinished storage cleanup retries automatically.'))
        else:
            raise ValidationError('Confirm permanent deletion or choose restore.')
        return redirect('trash')
    model = Folder if entry.kind == 'folder' else Document
    root = get_object_or_404(model.all_objects, pk=entry.root_id, trash=entry)
    folders, documents = subtree(root) if entry.kind == 'folder' else ([], [root])
    return render(request, 'wiki/trash_item.html', {'entry':entry, 'file_count':len(documents), 'folder_count':len(folders), 'section':'Trash'})
