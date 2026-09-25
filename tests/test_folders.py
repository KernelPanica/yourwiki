import pytest
from django.core.exceptions import PermissionDenied, ValidationError
from wiki.models import Folder
from wiki.folders import breadcrumbs, move_item

pytestmark=pytest.mark.django_db


def folder(workspace,name='Folder',parent=None):
    return Folder.objects.create(name=name,parent=parent,owner=workspace['admin'],group=workspace['team'])


def test_inheritance_and_private_ancestor_override(workspace,document):
    root=folder(workspace);root.policy['group']['read']=False;root.policy['group']['visible']=False;root.save()
    child=folder(workspace,'Child',root)
    document.folder=child;document.inherit_permissions=True;document.save()
    assert not document.allows(workspace['member'],'read')
    document.inherit_permissions=False;document.save()
    assert document.allows(workspace['member'],'read')
    assert breadcrumbs(child,workspace['member'])==[]


def test_move_requires_both_containers_and_prevents_cycles(workspace,document):
    root=folder(workspace);child=folder(workspace,'Child',root)
    with pytest.raises(ValidationError):move_item(workspace['admin'],root,child)
    document.folder=root;document.owner=workspace['member'];document.save()
    with pytest.raises(PermissionDenied):move_item(workspace['member'],document,child)
    move_item(workspace['admin'],document,child)
    assert document.folder_id==child.pk


def test_nonempty_folder_cannot_be_deleted(client,workspace,document):
    root=folder(workspace);document.folder=root;document.save()
    client.force_login(workspace['admin'])
    assert client.post(f'/folders/{root.pk}/',{'action':'delete'}).status_code==400
    assert Folder.objects.filter(pk=root.pk).exists()


def test_hidden_ancestor_is_not_serialized(client,workspace,document):
    root=folder(workspace,'SECRET FOLDER');root.policy['group']['visible']=False;root.save()
    document.folder=root;document.save()
    client.force_login(workspace['member'])
    response=client.get(f'/api/docs/{document.pk}')
    assert response.status_code==200 and response.json()['folder'] is None
    assert b'SECRET FOLDER' not in client.get('/api/folders').content


def test_path_creation_empty_files_and_uploads(client, workspace):
    from django.core.files.uploadedfile import SimpleUploadedFile
    from wiki.models import Document
    from wiki.storage import active_storage
    client.force_login(workspace['admin'])
    root = folder(workspace, 'Projects')
    response = client.post('/folders/new/', {'name':'Notes', 'path':'/Projects'})
    assert response.status_code == 302
    child = Folder.objects.get(name='Notes')
    assert child.parent == root
    assert client.post('/folders/new/', {'name':'../escape', 'path':'/'}).status_code == 400
    assert client.post('/folders/new/', {'name':'Notes', 'path':'/Projects'}).status_code == 400
    assert client.post('/folders/new/', {'name':'Bad', 'path':'/Projects/../'}).status_code == 400
    for kind in ('document', 'table', 'canvas', 'drawio', 'file'):
        response = client.post('/documents/new/', {'title':'Empty '+kind, 'kind':kind, 'collection':'Notes', 'group':workspace['team'].pk, 'path':'/Projects/Notes', 'content':''})
        assert response.status_code == 302
        doc = Document.objects.get(title='Empty '+kind)
        assert doc.folder == child and doc.inherit_permissions
        content = active_storage().read(doc.reference)
        if kind in ('document', 'table', 'file'): assert content == b''
        assert client.get(f'/documents/{doc.pk}/').status_code == 200
    payload = b'\x00\xff arbitrary binary bytes'
    response = client.post('/files/upload/', {'path':'/Projects/Notes', 'file':SimpleUploadedFile('archive.zip', payload)})
    assert response.status_code == 302
    doc = Document.objects.get(title='archive.zip')
    assert doc.kind == 'file' and doc.folder == child
    response = client.get(f'/documents/{doc.pk}/export/')
    assert response.content == payload
    assert 'attachment;' in response['Content-Disposition']
    assert client.get(f'/api/docs/{doc.pk}').json()['download_url']
    client.force_login(workspace['outsider'])
    assert client.get(f'/documents/{doc.pk}/export/').status_code == 500
    assert client.post('/files/upload/', {'path':'/Projects/Notes', 'file':SimpleUploadedFile('secret.txt', b'')}).status_code == 400


def test_drag_move_endpoint_checks_cycles_and_permissions(client, workspace, document):
    root = folder(workspace, 'Projects')
    child = folder(workspace, 'Child', root)
    client.force_login(workspace['admin'])
    response = client.post(f'/move/document/{document.pk}/', {'destination':child.pk}, HTTP_ACCEPT='application/json')
    assert response.json() == {'moved':True, 'url': f'/folders/{child.pk}/'}
    document.refresh_from_db()
    assert document.folder == child
    assert client.post(f'/move/folder/{root.pk}/', {'destination':child.pk}, HTTP_ACCEPT='application/json').status_code == 400
    client.force_login(workspace['member'])
    assert client.post(f'/move/document/{document.pk}/', {'destination':''}, HTTP_ACCEPT='application/json').status_code == 500


def test_provider_tree_tracks_nested_files_moves_and_legacy_revisions(client, workspace, document):
    from django.core.management import call_command
    from wiki.services import save_document
    from wiki.storage import active_storage
    root = workspace['root']
    legacy = document.reference
    client.force_login(workspace['admin'])
    assert client.post('/folders/new/', {'name':'Projects','path':'/'}).status_code == 302
    assert client.post('/folders/new/', {'name':'Notes','path':'/Projects'}).status_code == 302
    parent = Folder.objects.get(name='Projects')
    child = Folder.objects.get(name='Notes')
    assert (root/'Projects'/'Notes').is_dir()
    created = save_document(workspace['admin'], 'Plan', 'document', 'old internal value', 'hello', workspace['team'], folder=child)
    assert created.reference.startswith('Projects/Notes/')
    assert active_storage().read(created.reference) == b'hello'
    assert client.post(f'/move/document/{document.pk}/', {'destination':child.pk}).status_code == 302
    document.refresh_from_db()
    assert document.reference.startswith('Projects/Notes/') and (root/legacy).exists()
    assert client.post(f'/folders/{child.pk}/', {'action':'rename','name':'Memos'}).status_code == 302
    created.refresh_from_db()
    assert created.reference.startswith('Projects/Memos/')
    assert client.post('/folders/new/', {'name':'Archive','path':'/'}).status_code == 302
    archive = Folder.objects.get(name='Archive')
    assert client.post(f'/move/folder/{parent.pk}/', {'destination':archive.pk}).status_code == 302
    created.refresh_from_db()
    assert created.reference.startswith('Archive/Projects/Memos/')
    assert client.post(f'/move/folder/{parent.pk}/', {'destination':child.pk}).status_code == 400
    other = save_document(workspace['admin'], 'Old root', 'document', 'legacy', 'content', workspace['team'])
    other.path_synced = False
    other.save(update_fields=['path_synced'])
    old = other.reference
    call_command('sync_storage_tree', verbosity=0)
    other.refresh_from_db()
    assert other.path_synced and other.reference != old and (root/old).exists()
    assert active_storage().read(other.reference) == b'content'
    synced_reference = other.reference
    call_command('sync_storage_tree', verbosity=0)
    other.refresh_from_db()
    assert other.reference == synced_reference
    assert b'Label' not in client.get('/documents/new/').content
    assert b'Labels' not in client.get('/').content


def test_renaming_a_live_document_preserves_path_and_moves_revision(client, workspace, document):
    import json
    parent = folder(workspace, 'Articles')
    client.force_login(workspace['admin'])
    assert client.post(f'/move/document/{document.pk}/', {'destination':parent.pk}).status_code == 302
    document.refresh_from_db()
    previous = document.reference
    response = client.post(f'/api/docs/{document.pk}/metadata',
                           data=json.dumps({'title':'Updated title'}), content_type='application/json')
    assert response.status_code == 200
    document.refresh_from_db()
    assert document.title == 'Updated title'
    assert 'Updated title' in document.reference and document.reference.startswith('Articles/')
    assert previous != document.reference


def test_shared_directory_under_private_parent_accepts_uploads_without_leaking_path(client, workspace):
    from django.core.files.uploadedfile import SimpleUploadedFile
    from wiki.models import Document
    private = folder(workspace, 'Private')
    private.policy['group']['visible'] = False
    private.save()
    shared = folder(workspace, 'Shared', private)
    shared.inherit_permissions = False
    shared.policy['group']['write'] = True
    shared.save()
    client.force_login(workspace['member'])
    page = client.get(f'/folders/{shared.pk}/')
    assert page.status_code == 200 and b'/Private' not in page.content and b'>Private<' not in page.content
    assert f'?folder={shared.pk}'.encode() in page.content
    created = client.post('/files/upload/', {'path':'/', 'folder':str(shared.pk),
                     'file':SimpleUploadedFile('shared.txt', b'shared content')})
    assert created.status_code == 302
    assert Document.objects.get(title='shared.txt').folder_id == shared.pk
    response = client.post('/folders/new/', {'name':'Subfolder', 'path':'/', 'folder':str(shared.pk)})
    assert response.status_code == 302 and Folder.objects.get(name='Subfolder').parent_id == shared.pk
    assert b'/Private' not in client.get('/').content and b'>Private<' not in client.get('/').content
