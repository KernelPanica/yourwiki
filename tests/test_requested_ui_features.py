import pytest
from unittest.mock import Mock
from wiki.models import Folder, Document, PendingDeletion, SiteConfiguration
from wiki.crypto import encrypt
from wiki.services import save_document, cleanup_storage
from wiki.storage import active_storage

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize('configuration,visible', [({},False),
    ({'openai':{'enabled':False,'api_key':'secret','model':'test'}},False),
    ({'openai':{'enabled':True,'model':'test'}},False),
    ({'openai':{'enabled':True,'api_key':'secret','model':'test'}},True)])
def test_summary_visibility(client, workspace, document, configuration, visible):
    SiteConfiguration.objects.update_or_create(pk=1, defaults={'encrypted_ai_config':encrypt(configuration)})
    client.force_login(workspace['admin'])
    for suffix in ('', 'live/'):
        response = client.get(f'/documents/{document.pk}/{suffix}')
        assert response.status_code == 200
        assert (f'/documents/{document.pk}/summary/'.encode() in response.content) is visible
        assert b'secret' not in response.content


def tree(workspace):
    parent=Folder.objects.create(name='Delete parent',owner=workspace['admin'],group=workspace['team'])
    child=Folder.objects.create(name='Nested',parent=parent,owner=workspace['admin'],group=workspace['team'])
    docs=[save_document(workspace['admin'],name,'document','Notes','Text',workspace['team'],folder=folder,file_format='md')
          for name,folder in [('Root file',parent),('Child file',child)]]
    return parent,child,docs


def test_recursive_deletion_confirmation_and_storage(client,workspace):
    parent,child,docs=tree(workspace)
    client.force_login(workspace['admin']); url=f'/folders/{parent.pk}/delete/'
    assert client.get(url).status_code==200
    assert client.post(url,{}).status_code==400
    assert Document.objects.count()==2
    assert client.post(url,{'confirm':'on','deletion_version':client.get(url).context['deletion_version']}).status_code==302
    assert not Document.objects.exists() and not Folder.objects.exists()
    assert not PendingDeletion.objects.exists()
    assert (workspace['root']/'Delete parent').exists()


def test_recursive_delete_denied_child_leaves_everything(client,workspace):
    parent,child,docs=tree(workspace)
    docs[1].inherit_permissions=False
    docs[1].policy={'owner':{'read':True,'write':True},'group':{'read':True,'write':False},'everyone':{'read':False,'write':False}}
    docs[1].save()
    client.force_login(workspace['member'])
    assert client.post(f'/folders/{parent.pk}/delete/',{'confirm':'on'}).status_code in (403,404)
    assert Document.objects.count()==2 and Folder.objects.count()==2
    assert not PendingDeletion.objects.exists()


def test_recursive_delete_remote_failure_is_retryable(client,workspace,monkeypatch):
    parent,child,docs=tree(workspace); client.force_login(workspace['admin'])
    with monkeypatch.context() as m:
        m.setattr('wiki.storage.MountedStorage.delete',Mock(side_effect=OSError('offline')))
        assert client.post(f'/folders/{parent.pk}/delete/',{'confirm':'on','deletion_version':client.get(f'/folders/{parent.pk}/delete/').context['deletion_version']}).status_code==302
    from wiki.models import TrashEntry
    from wiki.trash import purge
    assert not PendingDeletion.objects.exists()
    with monkeypatch.context() as m:
        m.setattr('wiki.storage.MountedStorage.delete',Mock(side_effect=OSError('offline')))
        purge(workspace['admin'], TrashEntry.objects.get())
    assert PendingDeletion.objects.count()==4
    cleanup_storage()
    assert not PendingDeletion.objects.exists()
    assert not (workspace['root']/'Delete parent').exists()


def test_stale_deletion_confirmation_does_not_delete_new_file(client,workspace):
    parent,child,docs=tree(workspace);client.force_login(workspace['admin'])
    url=f'/folders/{parent.pk}/delete/'
    version=client.get(url).context['deletion_version']
    save_document(workspace['admin'],'New file','document','Notes','New content',workspace['team'],folder=parent,file_format='md')
    assert client.post(url,{'confirm':'on','deletion_version':version}).status_code==409
    assert Document.objects.count()==3
    assert not PendingDeletion.objects.exists()


def test_pending_deletion_scan_does_not_recreate_folder(client,workspace,monkeypatch):
    from django.core.management import call_command
    parent,child,docs=tree(workspace);client.force_login(workspace['admin'])
    url=f'/folders/{parent.pk}/delete/';version=client.get(url).context['deletion_version']
    with monkeypatch.context() as m:
        m.setattr('wiki.storage.MountedStorage.delete',Mock(side_effect=OSError('offline')))
        assert client.post(url,{'confirm':'on','deletion_version':version}).status_code==302
    call_command('scan_storage')
    assert not Folder.objects.exists() and not Document.objects.exists()
