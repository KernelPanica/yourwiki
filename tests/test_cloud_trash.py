import pytest
from unittest.mock import Mock
from wiki.crypto import encrypt
from wiki.models import Document, Folder, MountPoint, ProviderTrashState, TrashEntry
from wiki.services import delete_document
from wiki.trash import restore, trash_directory
from wiki.cloud_trash import synchronize
from wiki.storage import GoogleDrive, StorageError

pytestmark = pytest.mark.django_db


@pytest.fixture
def google(workspace, monkeypatch):
    mount = MountPoint.objects.create(path='/remote', provider='google', encrypted_config=encrypt({'provider':'google','root':'root'}))
    states = {}
    adapter = Mock()
    adapter.trash_state.side_effect = lambda ref: states[ref]
    adapter.set_trashed.side_effect = lambda ref,value: states.update({ref:value})
    monkeypatch.setattr('wiki.cloud_trash.mount_adapter', lambda mount:adapter)
    return mount, states, adapter


def remote_doc(workspace, google, folder=None, name='File'):
    mount, states, adapter = google
    doc = Document.objects.create(title=name, kind='file', owner=workspace['admin'],group=workspace['team'],folder=folder,
                                  reference=f'mount:{mount.pk}:{name}')
    states[name] = False
    return doc


def test_google_deletion_and_external_restore_preserve_identity(google, workspace, django_capture_on_commit_callbacks):
    doc = remote_doc(workspace,google)
    doc.policy = {'owner':{'read':True,'write':True},'group':{'read':True,'write':False},'everyone':{'read':False,'write':False}}
    doc.inherit_permissions = False;doc.save()
    original_policy, original_reference = doc.policy, doc.reference
    with django_capture_on_commit_callbacks(execute=True):
        delete_document(workspace['admin'],doc)
    assert google[1]['File'] is True
    assert ProviderTrashState.objects.get(document_id=doc.pk).confirmed
    assert not Document.objects.exists()
    google[1]['File'] = False  # Same state change as restoring in Google Drive UI.
    synchronize()
    restored = Document.objects.get(pk=doc.pk)
    assert restored.reference == original_reference and restored.policy == original_policy
    assert not TrashEntry.objects.exists() and not ProviderTrashState.objects.exists()


def test_restore_in_yourwiki_untrashes_google(google, workspace, django_capture_on_commit_callbacks):
    doc = remote_doc(workspace,google)
    with django_capture_on_commit_callbacks(execute=True):delete_document(workspace['admin'],doc)
    restore(workspace['admin'],TrashEntry.objects.get())
    assert google[1]['File'] is False and Document.objects.filter(pk=doc.pk).exists()


def test_network_failure_is_durable_and_not_mistaken_for_restore(google, workspace, django_capture_on_commit_callbacks):
    doc = remote_doc(workspace,google)
    google[2].set_trashed.side_effect = StorageError('offline')
    with django_capture_on_commit_callbacks(execute=True):delete_document(workspace['admin'],doc)
    row = ProviderTrashState.objects.get();assert not row.confirmed and row.error
    synchronize();assert not Document.objects.exists()
    google[2].set_trashed.side_effect = lambda ref,value:google[1].update({ref:value})
    synchronize();row.refresh_from_db();assert row.confirmed and not row.error and google[1]['File']


def test_uncertain_remote_success_is_reconciled(google, workspace, django_capture_on_commit_callbacks):
    doc = remote_doc(workspace,google)
    def uncertain(ref,value):
        google[1][ref] = value
        raise StorageError('lost response')
    google[2].set_trashed.side_effect = uncertain
    with django_capture_on_commit_callbacks(execute=True):delete_document(workspace['admin'],doc)
    assert google[1]['File'] and not ProviderTrashState.objects.get().confirmed
    synchronize();assert ProviderTrashState.objects.get().confirmed


def test_restore_one_remote_file_from_trashed_tree(google, workspace, django_capture_on_commit_callbacks):
    folder = Folder.objects.create(name='Folder',owner=workspace['admin'],group=workspace['team'])
    child = Folder.objects.create(name='Child',parent=folder,owner=workspace['admin'],group=workspace['team'])
    doc = remote_doc(workspace,google,child,'First');other = remote_doc(workspace,google,child,'Second')
    with django_capture_on_commit_callbacks(execute=True):trash_directory(workspace['admin'],folder)
    assert google[1] == {'First':True,'Second':True}
    google[1]['First'] = False;synchronize()
    assert Document.objects.filter(pk=doc.pk).exists()
    assert not Document.objects.filter(pk=other.pk).exists()
    assert Folder.objects.count() == 2
    assert TrashEntry.objects.get().root_id == other.pk
    assert google[1]['Second'] is True


def test_google_adapter_uses_trash_patch_not_delete(monkeypatch):
    adapter = GoogleDrive({'provider':'google'})
    adapter.headers = lambda:{}
    state = {'value':False};calls=[]
    def request(method,url,**kwargs):
        calls.append((method,kwargs))
        if method == 'PATCH':state['value']=kwargs['json']['trashed']
        return Mock(json=lambda:{'id':'file','trashed':state['value']})
    adapter.request = request
    adapter.set_trashed('file',True);assert adapter.trash_state('file')
    adapter.set_trashed('file',False);assert not adapter.trash_state('file')
    assert all(method != 'DELETE' for method,_ in calls)
    assert [kwargs['json'] for method,kwargs in calls if method == 'PATCH'] == [{'trashed':True},{'trashed':False}]
