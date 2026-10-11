import io
from pathlib import Path
from unittest.mock import Mock
import pytest
from django.core.management import call_command
from wiki.models import Document, Folder, MountPoint
from wiki.crypto import encrypt
from wiki.storage import root_mount, active_storage

pytestmark = pytest.mark.django_db


def test_all_files_and_empty_directories_are_indexed(workspace):
    root=workspace['root']
    (root/'Empty').mkdir()
    (root/'Nested').mkdir()
    (root/'Nested'/'unknown.iso').write_bytes(b'x'*(6*1024*1024))
    (root/'Nested'/'unsupported.docx').write_bytes(b'unsupported document data')
    (root/'data.json').write_text('{"user":"data"}')
    call_command('scan_storage', stdout=io.StringIO())
    assert set(Document.objects.values_list('title',flat=True))=={'unknown.iso','unsupported.docx','data.json'}
    assert Folder.objects.filter(name='Empty').exists()
    broken=Document.objects.get(title='unsupported.docx')
    assert broken.kind=='file' and broken.inherit_permissions
    call_command('scan_storage', stdout=io.StringIO())
    assert Document.objects.count()==3
    assert (root/'Nested'/'unsupported.docx').read_bytes()==b'unsupported document data'


def test_all_mounts_are_scanned_without_shadowing(workspace,tmp_path):
    root_mount()
    remote=tmp_path/'remote';remote.mkdir();(remote/'nested').mkdir();(remote/'nested'/'new.bin').write_bytes(b'new')
    folder=Folder.objects.create(name='Remote',owner=workspace['admin'],group=workspace['team'])
    mount=MountPoint.objects.create(path='/Remote',provider='local',folder=folder,encrypted_config=encrypt({'root':str(remote),'provider':'local'}))
    (workspace['root']/'Remote').mkdir();(workspace['root']/'Remote'/'shadow.bin').write_bytes(b'hidden')
    call_command('scan_storage',stdout=io.StringIO())
    doc=Document.objects.get()
    assert doc.title=='new.bin' and doc.reference==f'mount:{mount.pk}:nested/new.bin'
    assert doc.folder.parent==folder and doc.inherit_permissions


def test_unreadable_content_is_still_catalogued(workspace,monkeypatch,client):
    (workspace['root']/'native-object.bin').write_bytes(b'data')
    from wiki.storage import StorageError
    monkeypatch.setattr('wiki.storage.MountedStorage.read',Mock(side_effect=StorageError('Unsupported native content')))
    call_command('scan_storage',stdout=io.StringIO())
    assert Document.objects.get().title=='native-object.bin'
    assert Document.objects.get().storage_digest==''
    client.force_login(workspace['admin'])
    response=client.get(f'/documents/{Document.objects.get().pk}/')
    assert response.status_code==200
    assert b'native-object.bin' in response.content


def test_service_history_hidden_files_and_symlinks(workspace,document,tmp_path):
    root=workspace['root'];(root/'.report.bin').write_bytes(b'user file')
    private=root/'private-history.json';private.write_bytes(b'x'*(6*1024*1024))
    document.history_reference='private-history.json';document.save()
    outside=tmp_path/'outside';outside.write_bytes(b'outside root')
    (root/'symlink.bin').symlink_to(outside)
    call_command('scan_storage',stdout=io.StringIO())
    assert Document.objects.filter(title='.report.bin').exists()
    assert not Document.objects.filter(title='private-history.json').exists()
    assert not Document.objects.filter(title='symlink.bin').exists()


@pytest.mark.parametrize('provider',['onedrive','github','sftp','smb'])
def test_remote_adapter_recursive_listing(provider):
    import contextlib
    import stat
    from types import SimpleNamespace
    from wiki.storage import OneDrive,GitHub,SFTP,SMB
    def reply(data):
        return SimpleNamespace(json=lambda:data)
    if provider=='onedrive':
        adapter=OneDrive({'root':'root'})
        root=adapter.base+'/items/root/children';child=adapter.base+'/items/folder/children';page=root+'?$skiptoken=next'
        responses={root:{'value':[{'id':'folder','name':'Nested','folder':{}}],'@odata.nextLink':page},child:{'value':[{'id':'child','name':'file.bin','file':{}}]},page:{'value':[{'id':'top','name':'top.bin','file':{}}]}}
        adapter.headers=lambda:{};adapter.request=Mock(side_effect=lambda method,url,**kwargs:reply(responses[url]))
        assert set(adapter.scan())=={('Nested',None),('Nested/file.bin','child'),('top.bin','top')}
    elif provider=='github':
        adapter=GitHub({'repository':'user/repo','branch':'main','root':''});adapter.private_repository=Mock();adapter.headers=lambda:{}
        nodes={'main':[{'path':'Nested','type':'tree','sha':'child'}],'child':[{'path':'file.bin','type':'blob','mode':'100644'},{'path':'link.bin','type':'blob','mode':'120000'}]}
        adapter.request=Mock(side_effect=lambda method,url,**kwargs:reply({'tree':nodes[url.rsplit('/',1)[-1]]}))
        assert set(adapter.scan())=={('Nested',None),('Nested/file.bin','Nested/file.bin')}
    elif provider=='sftp':
        adapter=SFTP({'root':'/root'})
        client=Mock();client.listdir_attr.side_effect=lambda path:[SimpleNamespace(filename='Nested',st_mode=stat.S_IFDIR)] if path=='/root' else [SimpleNamespace(filename='file.bin',st_mode=stat.S_IFREG),SimpleNamespace(filename='link.bin',st_mode=stat.S_IFLNK)]
        adapter.client=lambda:contextlib.nullcontext(client)
        assert set(adapter.scan())=={('Nested',None),('Nested/file.bin','Nested/file.bin')}
    else:
        adapter=SMB({'root':'root','host':'host','share':'share'})
        def entry(name,directory=False,symlink=False):
            return SimpleNamespace(name=name,is_symlink=lambda:symlink,is_dir=lambda:directory,is_file=lambda:not directory)
        client=Mock();client.scandir.side_effect=lambda path,**kwargs:[entry('file.bin'),entry('link.bin',symlink=True)] if path.endswith('Nested') else [entry('Nested',directory=True)]
        adapter.client=lambda:client
        assert set(adapter.scan())=={('Nested',None),('Nested/file.bin','Nested/file.bin')}
