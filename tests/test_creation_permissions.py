import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from wiki.models import Document, Folder

pytestmark = pytest.mark.django_db


def parent(workspace):
    folder=Folder.objects.create(name='Parent',owner=workspace['admin'],group=workspace['team'],inherit_permissions=False)
    folder.policy['group']={'read':True,'write':True};folder.save()
    return folder


@pytest.mark.parametrize('url', ['/documents/new/','/folders/new/','/files/upload/'])
@pytest.mark.parametrize('role', ['admin','member'])
def test_creation_has_no_acl_matrix(client,workspace,url,role):
    client.force_login(workspace[role])
    page=client.get(url)
    assert page.status_code==200
    assert b'permission_owner_' not in page.content and b'name="group"' not in page.content
    assert b'Access is inherited' in page.content


@pytest.mark.parametrize('kind',['document','table','file'])
def test_creation_inherits_and_ignores_legacy_acl_injection(client,workspace,kind):
    folder=parent(workspace)
    client.force_login(workspace['member'])
    response=client.post('/documents/new/',{'title':'Inherited','kind':kind,'path':'/Parent','content':'',
        'permissions_mode':'custom','permission_everyone_write':'on','permission_everyone_read':'on'})
    assert response.status_code==302,response.content
    doc=Document.objects.get(title='Inherited')
    assert doc.inherit_permissions and doc.allows(workspace['member'],'write')
    assert not doc.allows(workspace['outsider'],'read')
    folder.policy['group']['write']=False;folder.save()
    assert not Document.objects.get(pk=doc.pk).allows(workspace['member'],'write')


def test_folder_and_upload_inherit(client,workspace):
    folder=parent(workspace);client.force_login(workspace['member'])
    assert client.post('/folders/new/',{'name':'Child','path':'/Parent'}).status_code==302
    child=Folder.objects.get(name='Child')
    assert child.inherit_permissions and child.group_id==folder.group_id
    assert client.post('/files/upload/',{'folder':str(child.pk),'path':'/', 'file':SimpleUploadedFile('test.bin',b'data')}).status_code==302
    doc=Document.objects.get(title='test.bin')
    assert doc.inherit_permissions and doc.allows(workspace['member'],'write')


def test_multiple_group_rules_settings_reload_and_move(client,workspace):
    from django.contrib.auth.models import Group
    from wiki.folders import move_item
    from wiki.services import save_document
    reviewers=Group.objects.create(name='Reviewers');editors=Group.objects.create(name='Editors')
    member=workspace['member'];member.groups.add(reviewers)
    outsider=workspace['outsider'];outsider.groups.add(editors)
    doc=save_document(workspace['admin'],'Shared','document','Notes','',workspace['team'])
    client.force_login(workspace['admin'])
    url=f'/documents/{doc.pk}/file-settings/'
    response=client.post(url,{'action':'access','group':workspace['team'].pk,'owner.write':'on',
        f'group.{reviewers.pk}.enabled':'on',f'group.{reviewers.pk}.read':'on',
        f'group.{editors.pk}.enabled':'on',f'group.{editors.pk}.write':'on'})
    assert response.status_code==302
    doc.refresh_from_db()
    assert doc.allows(member,'read') and not doc.allows(member,'write')
    assert doc.allows(outsider,'write') and doc.allows(outsider,'read')
    member.groups.add(editors);assert doc.allows(member,'write')
    move_item(workspace['admin'],doc,parent(workspace));doc.refresh_from_db()
    assert not doc.inherit_permissions and doc.allows(outsider,'write')
    assert f'name="group.{editors.pk}.enabled"'.encode() in client.get(url).content


def test_explicit_group_deny_is_inherited(client,workspace):
    root=parent(workspace);group=workspace['team']
    client.force_login(workspace['admin'])
    assert client.post(f'/folders/{root.pk}/file-settings/',{'action':'access','group':group.pk,
        'owner.write':'on','group.write':'on',f'group.{group.pk}.enabled':'on'}).status_code==302
    root.refresh_from_db()
    child=Folder.objects.create(name='Child',parent=root,owner=workspace['admin'],group=group)
    assert not child.allows(workspace['member'],'read')
    root.group_policies[str(group.pk)]={'read':False,'write':True};root.save()
    assert Folder.objects.get(pk=child.pk).allows(workspace['member'],'read')


def test_new_document_defaults_to_docx(client, workspace):
    from wiki.forms import DocumentForm
    form = DocumentForm(user=workspace['admin'])
    assert form['file_format'].value() == 'docx'
    client.force_login(workspace['admin'])
    response = client.post('/documents/new/', {
        'title': 'Default Word', 'kind': 'document', 'group': workspace['team'].pk,
        'path': '/', 'content': 'Word by default',
    })
    assert response.status_code == 302
    document = Document.objects.get(title='Default Word')
    assert document.file_format == 'docx'
    assert document.reference.endswith('.docx')


@pytest.mark.parametrize(('kind', 'file_format', 'title', 'suffix'), [
    ('document', 'docx', 'Report.md', '.docx'),
    ('document', 'md', 'Report.DOCX', '.md'),
    ('table', '', 'Report.docx', '.ods'),
    ('drawio', '', 'Report.ods', '.drawio'),
    ('canvas', '', 'Report.drawio', '.canvas'),
    ('file', '', 'Report.txt', '.txt'),
])
def test_creation_applies_selected_extension(client, workspace, kind, file_format, title, suffix):
    client.force_login(workspace['admin'])
    response = client.post('/documents/new/', {
        'title': title, 'kind': kind, 'file_format': file_format,
        'group': workspace['team'].pk, 'path': '/', 'content': '',
    })
    assert response.status_code == 302
    doc = Document.objects.get(title='Report.txt' if kind == 'file' else 'Report')
    from wiki.storage import active_storage
    assert active_storage().location(doc.reference).endswith('Report' + suffix)
