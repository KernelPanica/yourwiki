import itertools
import uuid
from unittest.mock import patch
import pytest
from wiki.models import Folder, SiteConfiguration, default_policy
from wiki.services import save_document

pytestmark = pytest.mark.django_db


def test_write_implies_read_and_no_visibility_flag(workspace, document):
    document.policy['group'] = {'read': False, 'write': True}
    document.save()
    assert document.allows(workspace['member'], 'read')
    assert set(default_policy()['owner']) == {'read','write'}


def test_unreadable_is_missing_in_lists_and_direct_urls(client, workspace, document):
    document.policy['group'] = {'read':False,'write':False}
    document.save()
    client.force_login(workspace['member'])
    assert str(document.pk) not in client.get('/api/docs').content.decode()
    assert document.title not in client.get('/folders/').content.decode()
    for suffix in ['', 'export/', 'live/']:
        hidden = client.get(f'/documents/{document.pk}/{suffix}')
        missing = client.get(f'/documents/{uuid.uuid4()}/{suffix}')
        assert hidden.status_code == missing.status_code == 404
    with patch('wiki.views.active_storage') as storage:
        assert client.get(f'/documents/{document.pk}/export/').status_code == 404
        storage.assert_not_called()


def test_safe_legacy_conversion():
    from wiki.acl import normalize_rule
    for visible,read,write in itertools.product([False,True],repeat=3):
        assert normalize_rule({'visible':visible,'read':read,'write':write}) == {
            'read': visible and (read or write), 'write': visible and write}


def test_root_defaults_are_inherited(workspace, document):
    site = SiteConfiguration.current()
    site.default_document_policy = default_policy()
    site.default_document_policy['group'] = {'read':False,'write':False}
    site.save()
    document.inherit_permissions=True;document.save()
    assert not document.allows(workspace['member'],'read')
    site.default_document_policy['group']['write']=True;site.save()
    assert document.allows(workspace['member'],'read')


def test_creation_is_simple_and_inherits_group(client, workspace):
    parent=Folder.objects.create(name='Team',owner=workspace['admin'],group=workspace['team'])
    client.force_login(workspace['admin'])
    html=client.get('/documents/new/').content.decode()
    assert 'permission_owner_' not in html
    assert 'name="group"' not in html
    result=client.post('/documents/new/', {'title':'Simple','kind':'document','file_format':'docx','folder':str(parent.pk),'content':''})
    assert result.status_code==302
    from wiki.models import Document
    doc=Document.objects.get(title='Simple')
    assert doc.inherit_permissions and doc.group_id==parent.group_id


def test_api_create_in_folder_and_admin_only_acl(client, workspace):
    parent=Folder.objects.create(name='Team',owner=workspace['admin'],group=workspace['team'])
    parent.policy['group']={'read':True,'write':True};parent.inherit_permissions=False;parent.save()
    client.force_login(workspace['member'])
    response=client.post('/api/docs', {'title':'Via API','kind':'document','content':'hello','folder':str(parent.pk)},content_type='application/json')
    assert response.status_code==201,response.content
    from wiki.models import Document
    doc=Document.objects.get(title='Via API')
    assert doc.folder_id==parent.pk and doc.inherit_permissions
    denied=client.put(f'/api/docs/{doc.pk}', {'policy':default_policy()},content_type='application/json')
    assert denied.status_code==403
    client.force_login(workspace['admin'])
    policy=default_policy();policy['group']={'read':False,'write':True}
    response=client.put(f'/api/docs/{doc.pk}', {'policy':policy,'inherit_permissions':False},content_type='application/json')
    assert response.status_code==200,response.content
    doc.refresh_from_db()
    assert doc.policy['group']=={'read':True,'write':True}
    assert set(response.json()['access'])=={'read','write'}


@pytest.mark.parametrize('provider', ['local','google','onedrive','github','sftp','smb'])
def test_provider_binary_rw_contract(client, workspace, provider):
    from unittest.mock import Mock
    from wiki.models import MountPoint, Document
    from wiki.crypto import encrypt
    import hashlib
    mount=MountPoint.objects.create(path='/',provider=provider,encrypted_config=encrypt({'provider':provider}))
    doc=Document.objects.create(title='bytes.bin',kind='file',owner=workspace['admin'],group=workspace['team'],
        reference=f'mount:{mount.pk}:bytes.bin',inherit_permissions=False,storage_digest=hashlib.sha256(b'old').hexdigest())
    adapter=Mock()
    adapter.read.return_value=b'old';adapter.write.return_value='bytes.bin'
    adapter.location.return_value='bytes.bin'
    adapter.fingerprint.side_effect=lambda ref,raw:hashlib.sha256(raw).hexdigest()
    url=f'/api/docs/{doc.pk}/file'
    with patch('wiki.storage.mount_adapter',return_value=adapter):
        client.force_login(workspace['member'])
        response=client.get(url)
        assert response.status_code==200 and response.content==b'old'
        assert response['ETag']=='"1"'
        adapter.reset_mock()
        assert client.put(url,b'new',content_type='application/octet-stream',HTTP_IF_MATCH='"1"').status_code==403
        adapter.write.assert_not_called()
        client.force_login(workspace['outsider']);adapter.reset_mock()
        assert client.get(url).status_code==404
        adapter.read.assert_not_called()
        client.force_login(workspace['admin'])
        response=client.put(url,b'new',content_type='application/octet-stream',HTTP_IF_MATCH='"1"')
        assert response.status_code==200,response.content
        assert response['ETag']=='"2"'
        assert adapter.write.call_args.args[1]==b'new'
        adapter.reset_mock()
        assert client.put(url,b'stale',content_type='application/octet-stream',HTTP_IF_MATCH='"1"').status_code==409
        adapter.write.assert_not_called()


def test_migration_preserves_hidden_and_explicit_acl(workspace,document):
    from importlib import import_module
    from django.apps import apps
    from django.db import connection
    document.policy['group']={'visible':False,'read':True,'write':True}
    document.group_policies={str(workspace['team'].pk):{'visible':True,'read':False,'write':True}}
    document.inherit_permissions=True;document.save()
    parent=Folder.objects.create(name='Existing root',owner=workspace['admin'],group=workspace['team'])
    parent.policy['group']={'visible':False,'read':True,'write':False};parent.save()
    with patch('wiki.storage.active_storage') as storage:
        import_module('wiki.migrations.0015_read_write_permissions').migrate_permissions(apps,connection.schema_editor())
        storage.assert_not_called()
    document.refresh_from_db();parent.refresh_from_db()
    assert document.policy['group']=={'read':False,'write':False}
    assert document.group_policies[str(workspace['team'].pk)]=={'read':True,'write':True}
    assert not document.inherit_permissions and not parent.inherit_permissions
    assert not parent.allows(workspace['member'],'read')


def test_settings_rw_server_validation_and_redirect(client, workspace, document):
    client.force_login(workspace['admin'])
    url=f'/documents/{document.pk}/file-settings/'
    assert client.get(f'/documents/{document.pk}/permissions/')['Location']==url+'#access'
    response=client.post(url,{'action':'access','group':workspace['team'].pk,'owner.write':'on','group.write':'on'})
    assert response.status_code==302,response.content
    document.refresh_from_db()
    assert document.policy['group']=={'read':True,'write':True}
    assert document.allows(workspace['member'],'read')
    client.force_login(workspace['member'])
    assert client.post(url,{'action':'access','group':workspace['team'].pk}).status_code==403
    document.refresh_from_db()
    assert document.allows(workspace['member'],'write')


def test_folder_api_and_revocation(client,workspace,document):
    client.force_login(workspace['admin'])
    response=client.post('/api/folders',{'name':'API folder'},content_type='application/json')
    assert response.status_code==201,response.content
    folder=Folder.objects.get(pk=response.json()['id'])
    document.folder=folder;document.inherit_permissions=True;document.save()
    policy=default_policy();policy['group']={'read':False,'write':False}
    response=client.put(f'/api/folders/{folder.pk}',{'policy':policy},content_type='application/json')
    assert response.status_code==200
    client.force_login(workspace['member'])
    assert client.get(f'/api/docs/{document.pk}').status_code==404
    assert client.get(f'/api/folders/{folder.pk}').status_code==404
    assert client.post('/api/docs',{'title':'Forbidden','folder':str(folder.pk)},content_type='application/json').status_code==404


def test_readonly_websocket_cannot_force_provider_write(monkeypatch):
    import asyncio
    import json
    from types import SimpleNamespace
    from unittest.mock import Mock
    from wiki import realtime
    monkeypatch.setattr(realtime,'authenticate',lambda *args:(SimpleNamespace(label='Reader'),False))
    monkeypatch.setattr(realtime,'load_state',lambda *args:{'type':'state','sequence':1,'synced_sequence':0})
    flush=Mock();monkeypatch.setattr(realtime,'flush_room',flush)
    events=iter([{'type':'websocket.connect'},{'type':'websocket.receive','text':json.dumps({'type':'save'})},{'type':'websocket.disconnect'}])
    sent=[]
    async def receive():return next(events)
    async def send(value):sent.append(value)
    asyncio.run(realtime.application({'type':'websocket','path':f'/ws/documents/{uuid.uuid4()}/'},receive,send))
    flush.assert_not_called()
    assert any(event['type']=='websocket.close' for event in sent)


def test_scanned_files_inherit_workspace_and_parent(workspace):
    from django.core.management import call_command
    from wiki.models import Document
    (workspace['root']/'discovered.txt').write_text('root file')
    folder=Folder.objects.create(name='Scan',owner=workspace['admin'],group=workspace['team'],inherit_permissions=False)
    (workspace['root']/'Scan').mkdir()
    (workspace['root']/'Scan'/'nested.txt').write_text('nested file')
    call_command('scan_storage')
    root=Document.objects.get(title='discovered.txt');nested=Document.objects.get(title='nested.txt')
    assert root.inherit_permissions and nested.inherit_permissions
    config=SiteConfiguration.current();config.default_document_policy=default_policy()
    config.default_document_policy['group']={'read':False,'write':False};config.save()
    assert not root.allows(workspace['member'],'read')
    assert nested.allows(workspace['member'],'read')


@pytest.mark.parametrize('payload',[
    {'inherit_permissions':'false'},
    {'group_policies':{'missing':{'read':True,'write':True}}},
    {'group_policies':[]},
    {'policy':{'owner':{'read':True,'write':True}}},
    {'policy':{scope:{'read':'true','write':False} for scope in ('owner','group','everyone')}},
    {'policy':{scope:{'visible':True,'read':True,'write':False} for scope in ('owner','group','everyone')}},
])
def test_invalid_acl_api_is_atomic(client,workspace,document,payload):
    client.force_login(workspace['admin'])
    old=document.policy.copy()
    response=client.put(f'/api/docs/{document.pk}',payload,content_type='application/json')
    assert response.status_code==400,response.content
    document.refresh_from_db()
    assert document.policy==old and document.group_policies=={} and not document.inherit_permissions
