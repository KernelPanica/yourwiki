import pytest
from django.core.exceptions import ValidationError
from unittest.mock import patch
from wiki.crypto import decrypt
from wiki.folders import move_item
from wiki.models import Attachment, Folder, MountPoint, PendingDeletion
from wiki.mounts import create_mount
from wiki.services import cleanup_storage, save_document
from wiki.storage import active_storage, root_mount, StorageError

pytestmark = pytest.mark.django_db


def test_upgrade_adopts_existing_storage_as_root(workspace):
    from importlib import import_module
    from django.apps import apps
    import_module('wiki.migrations.0009_mountpoint').root_mount(apps, None)
    mount = MountPoint.objects.get(path='/')
    assert mount.encrypted_config == workspace['ws'].encrypted_config
    assert mount.provider == 'local' and mount.folder is None


def mount(workspace, tmp_path, path):
    root = tmp_path / path.strip('/').replace('/', '-')
    root.mkdir()
    return create_mount(workspace['admin'], path, {'provider':'local', 'root':str(root)}), root


def test_root_and_longest_mount_routing_preserve_existing_references(workspace, document, tmp_path):
    adapter = active_storage()
    before = adapter.read(document.reference)
    assert root_mount().path == '/'
    parent, parent_root = mount(workspace, tmp_path, '/Projects')
    nested, nested_root = mount(workspace, tmp_path, '/Projects/archive')
    a = adapter.write('Projects/notes.txt', b'parent')
    b = adapter.write('Projects/archive/notes.txt', b'nested')
    c = adapter.write('Projects-other/notes.txt', b'root')
    assert a == f'mount:{parent.pk}:notes.txt'
    assert b == f'mount:{nested.pk}:notes.txt'
    assert (parent_root/'notes.txt').read_bytes() == b'parent'
    assert (nested_root/'notes.txt').read_bytes() == b'nested'
    assert (workspace['root']/'Projects-other/notes.txt').read_bytes() == b'root'
    assert adapter.read(document.reference) == before
    adapter.write('ignored.txt', b'updated', reference=b)
    assert adapter.read(b) == b'updated'
    PendingDeletion.objects.create(reference=b)
    cleanup_storage()
    assert not (nested_root/'notes.txt').exists()
    assert adapter.read(a) == b'parent' and adapter.read(c) == b'root'
    with pytest.raises(StorageError):
        adapter.write('Projects/../escape', b'bad')


def test_cross_mount_moves_copy_attachments_and_empty_subdirectories(workspace, document, tmp_path):
    destination, root = mount(workspace, tmp_path, '/Remote')
    adapter = active_storage()
    attachment = Attachment.objects.create(document=document, reference=adapter.write('old-image.png', b'image'), content_type='image/png')
    directory = Folder.objects.create(name='Notes', owner=workspace['admin'], group=workspace['team'])
    Folder.objects.create(name='Empty', parent=directory, owner=workspace['admin'], group=workspace['team'])
    document.folder = directory
    document.save()
    move_item(workspace['admin'], directory, destination.folder)
    document.refresh_from_db()
    attachment.refresh_from_db()
    assert document.reference.startswith(f'mount:{destination.pk}:Notes/')
    assert attachment.reference.startswith(f'mount:{destination.pk}:Notes/.attachments/')
    assert (root/'Notes/Empty').is_dir()
    assert adapter.read(attachment.reference) == b'image'
    move_item(workspace['admin'], document, None)
    attachment.refresh_from_db()
    assert not document.reference.startswith('mount:')
    assert not attachment.reference.startswith('mount:')
    assert adapter.read(attachment.reference) == b'image'


def test_failed_move_preserves_original_file(workspace, document, tmp_path):
    destination, _ = mount(workspace, tmp_path, '/Remote')
    before = document.reference
    adapter = active_storage()
    with patch('wiki.folders.active_storage', return_value=adapter), patch.object(adapter, 'write', side_effect=StorageError('offline')):
        with pytest.raises(StorageError):
            move_item(workspace['admin'], document, destination.folder)
    document.refresh_from_db()
    assert document.reference == before and document.folder is None
    assert b'Hello' in adapter.read(document.reference)


def test_keyboard_move_form_supports_files_and_directories(client, workspace, document, tmp_path):
    destination, _ = mount(workspace, tmp_path, '/Remote')
    client.force_login(workspace['admin'])
    assert client.get(f'/move/document/{document.pk}/').status_code == 200
    assert client.get(f'/move/folder/{destination.folder_id}/').status_code == 200


def test_mount_admin_creation_reconnect_and_unmount(client, workspace, tmp_path):
    client.force_login(workspace['member'])
    assert client.get('/mounts/').status_code == 500
    client.force_login(workspace['admin'])
    root = tmp_path/'remote'
    response = client.post('/mounts/', {'provider':'local', 'path':'/Projects/Archive', 'root':str(root)})
    assert response.status_code == 302
    item = MountPoint.objects.get(path='/Projects/Archive')
    assert item.folder.parent.name == 'Projects'
    assert decrypt(item.encrypted_config)['root'] == str(root)
    assert client.post('/mounts/', {'action':'test', 'mount':item.pk}).status_code == 302
    assert client.post(f'/mounts/?edit={item.pk}', {'provider':'local', 'path':'/Wrong', 'root':'/wrong'}).status_code == 302
    item.refresh_from_db()
    assert item.path == '/Projects/Archive' and decrypt(item.encrypted_config)['root'] == str(root)
    assert client.post('/mounts/', {'action':'unmount', 'mount':root_mount().pk}).status_code == 400
    save_document(workspace['admin'], 'Keep', 'file', 'Files', b'data', workspace['team'], folder=item.folder)
    assert client.post('/mounts/', {'action':'unmount', 'mount':item.pk}).status_code == 400
    empty, _ = mount(workspace, tmp_path, '/Empty')
    assert client.post('/mounts/', {'action':'unmount', 'mount':empty.pk}).status_code == 302
    assert Folder.objects.filter(pk=empty.folder_id).exists()


def test_mount_boundaries_cannot_hide_files_or_move_with_parent(client, workspace, document, tmp_path):
    remote, _ = mount(workspace, tmp_path, '/Parent/Remote')
    client.force_login(workspace['admin'])
    assert client.post(f'/folders/{remote.folder_id}/', {'action':'delete'}).status_code == 400
    assert client.post(f'/folders/{remote.folder.parent_id}/', {'action':'rename', 'name':'Oops'}).status_code == 400
    with pytest.raises(ValidationError):
        create_mount(workspace['admin'], '/Parent', {'provider':'local', 'root':str(tmp_path)})
    with pytest.raises(ValidationError):
        create_mount(workspace['admin'], '/Parent/../Escape', {'provider':'local', 'root':str(tmp_path)})
    folder = Folder.objects.create(name='Occupied', owner=workspace['admin'], group=workspace['team'])
    document.folder = folder
    document.save()
    with pytest.raises(ValidationError):
        create_mount(workspace['admin'], '/Occupied', {'provider':'local', 'root':str(tmp_path)})


def test_mount_path_is_not_disclosed_through_shared_child(client, workspace, tmp_path):
    remote, _ = mount(workspace, tmp_path, '/Private/Shared')
    private = remote.folder.parent
    private.policy['group']['visible'] = False
    private.save()
    shared = remote.folder
    shared.inherit_permissions = False
    shared.save()
    client.force_login(workspace['member'])
    response = client.get(f'/folders/{shared.pk}/')
    assert response.status_code == 200
    assert b'/Private' not in response.content


def test_folder_grants_support_multiple_groups(workspace):
    from django.contrib.auth.models import Group
    from wiki.models import Folder, default_policy
    reviewers = Group.objects.create(name='reviewers')
    editors = Group.objects.create(name='editors')
    user = workspace['member']; user.groups.add(reviewers)
    folder = Folder.objects.create(name='Shared', owner=workspace['admin'], group=workspace['team'], group_policies={str(reviewers.pk): {'visible':True,'read':True,'write':False}, str(editors.pk): {'visible':True,'read':True,'write':True}})
    assert folder.allows(user, 'visible') and folder.allows(user, 'read') and not folder.allows(user, 'write')
    user.groups.add(editors)
    assert folder.allows(user, 'write')
