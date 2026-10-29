import pytest
from django.core.management import call_command
from django.core.exceptions import ValidationError
from wiki.models import Document, Folder, TrashEntry, PendingDeletion, Attachment
from wiki.services import delete_document, cleanup_storage
from wiki.storage import active_storage
from wiki.trash import restore, purge
from tests.test_requested_ui_features import tree

pytestmark = pytest.mark.django_db


def test_file_trash_preserves_original_and_denies_every_entrypoint(client, workspace, document):
    original = active_storage().read(document.reference)
    delete_document(workspace['admin'], document)
    entry = TrashEntry.objects.get()
    assert not Document.objects.filter(pk=document.pk).exists()
    assert Document.all_objects.get(pk=document.pk).trash_id == entry.pk
    assert active_storage().read(document.reference) == original
    assert not PendingDeletion.objects.exists()
    for user in [workspace['admin'], workspace['member']]:
        client.force_login(user)
        for suffix in ['', 'edit/', 'export/', 'file-settings/', 'live/']:
            assert client.get(f'/documents/{document.pk}/{suffix}').status_code == 404
        assert client.get(f'/api/docs/{document.pk}').status_code == 404
    call_command('scan_storage')
    assert Document.all_objects.count() == 1
    restore(workspace['admin'], entry)
    assert Document.objects.get(pk=document.pk).reference == document.reference
    assert active_storage().read(document.reference) == original


def test_bin_admin_only_get_post_and_navigation(client, workspace, document):
    delete_document(workspace['admin'], document)
    entry = TrashEntry.objects.get()
    client.force_login(workspace['member'])
    assert b'href="/trash/"' not in client.get('/folders/').content
    for url in ['/trash/', f'/trash/{entry.pk}/']:
        assert client.get(url).status_code == 403
        assert client.post(url, {'action':'restore'}).status_code in (403,405)
        assert client.post(url, {'action':'purge','confirm':'on'}).status_code in (403,405)
    assert Document.all_objects.get(pk=document.pk).trash_id
    client.force_login(workspace['admin'])
    assert client.get('/trash/').status_code == 200
    assert client.get(f'/trash/{entry.pk}/').status_code == 200
    assert client.post(f'/trash/{entry.pk}/', {'action':'purge'}).status_code == 400
    assert client.post(f'/trash/{entry.pk}/', {'action':'restore'}).status_code == 302


def test_recursive_restore_retains_prior_separate_trash(workspace):
    from wiki.trash import trash_directory
    parent, child, docs = tree(workspace)
    previous = delete_document(workspace['admin'], docs[1])
    old_entry = TrashEntry.objects.get()
    entry = trash_directory(workspace['admin'], parent)
    call_command('scan_storage')
    assert not Document.objects.exists() and not Folder.objects.exists()
    assert Document.all_objects.count() == 2 and Folder.all_objects.count() == 2
    with pytest.raises(ValidationError):
        restore(workspace['admin'], old_entry)
    restore(workspace['admin'], entry)
    assert Folder.objects.count() == 2 and Document.objects.count() == 1
    restore(workspace['admin'], old_entry)
    assert Document.objects.count() == 2


def test_purge_includes_previous_trash_and_storage_retry(workspace, monkeypatch, django_capture_on_commit_callbacks):
    from wiki.trash import trash_directory
    from wiki.services import cleanup_storage
    parent, child, docs = tree(workspace)
    delete_document(workspace['admin'], docs[1])
    entry = trash_directory(workspace['admin'], parent)
    with monkeypatch.context() as m:
        m.setattr('wiki.storage.MountedStorage.delete', lambda *args: (_ for _ in ()).throw(OSError('offline')))
        with django_capture_on_commit_callbacks(execute=True):
            purge(workspace['admin'], entry)
    assert not Document.all_objects.exists() and not Folder.all_objects.exists()
    assert not TrashEntry.objects.exists()
    assert PendingDeletion.objects.count() == 4
    call_command('scan_storage')
    assert not Document.objects.exists() and not Folder.objects.exists()
    cleanup_storage()
    assert not PendingDeletion.objects.exists()
    assert not (workspace['root'] / 'Delete parent').exists()


def test_attachment_and_history_retained_then_purged(workspace, document, django_capture_on_commit_callbacks):
    adapter = active_storage()
    reference = adapter.write('.attachments/picture.png', b'image')
    Attachment.objects.create(document=document, reference=reference, content_type='image/png')
    document.history_reference = adapter.write('history.json', b'{}')
    document.save(update_fields=['history_reference'])
    delete_document(workspace['admin'], document)
    assert adapter.read(reference) == b'image'
    with django_capture_on_commit_callbacks(execute=True):
        purge(workspace['admin'], TrashEntry.objects.get())
    cleanup_storage()
    assert not Attachment.objects.exists() and not PendingDeletion.objects.exists()

def test_mount_cannot_hide_trashed_sources_and_group_delete_has_clear_error(client, workspace):
    from django.contrib.auth.models import Group
    from wiki.mounts import create_mount
    from wiki.trash import trash_directory
    group = Group.objects.create(name='Trash only group')
    folder = Folder.objects.create(name='Reserved', owner=workspace['admin'], group=group)
    trash_directory(workspace['admin'], folder)
    with pytest.raises(ValidationError):
        create_mount(workspace['admin'], '/Reserved', {'provider':'local','root':str(workspace['root'])})
    client.force_login(workspace['admin'])
    assert client.post('/groups/', {'action':'delete','group':group.pk}).status_code == 302
    assert Group.objects.filter(pk=group.pk).exists()

def test_trashed_ancestor_also_denies_unmarked_children(workspace):
    from wiki.trash import trash_directory
    parent, child, docs = tree(workspace)
    trash_directory(workspace['admin'], parent)
    Document.all_objects.filter(pk=docs[1].pk).update(trash=None)
    doc = Document.all_objects.select_related('folder__parent').get(pk=docs[1].pk)
    for user in [workspace['admin'], workspace['member']]:
        assert not doc.allows(user, 'read') and not doc.allows(user, 'write')
