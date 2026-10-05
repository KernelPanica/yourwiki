import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from wiki.models import Document, Folder

pytestmark = pytest.mark.django_db


def explicit():
    return {'permissions_mode': 'custom', 'permission_owner_visible': 'on',
            'permission_owner_read': 'on', 'permission_owner_write': 'on',
            'permission_group_visible': 'on', 'permission_group_read': 'on'}


def parent(workspace):
    folder = Folder.objects.create(name='Parent', owner=workspace['admin'], group=workspace['team'])
    folder.policy['group']['write'] = True
    folder.save()
    return folder


@pytest.mark.parametrize('url', ['/documents/new/', '/folders/new/', '/files/upload/'])
def test_creation_matrix_is_available_to_administrators(client, workspace, url):
    client.force_login(workspace['admin'])
    page = client.get(url)
    assert page.status_code == 200
    assert b'data-creation-permissions' in page.content
    assert b'name="permission_group_write"' in page.content
    client.force_login(workspace['member'])
    page = client.get(url)
    assert b'data-creation-permissions' not in page.content


@pytest.mark.parametrize('kind', ['document', 'table', 'file'])
def test_explicit_file_acl_applies_at_creation(client, workspace, kind):
    folder = parent(workspace)
    client.force_login(workspace['admin'])
    response = client.post('/documents/new/', {
        'title': 'Explicit', 'kind': kind, 'group': workspace['team'].pk,
        'path': '/Parent', 'content': '', **explicit(),
    })
    assert response.status_code == 302
    doc = Document.objects.get(title='Explicit')
    assert not doc.inherit_permissions
    assert doc.allows(workspace['member'], 'read')
    assert not doc.allows(workspace['member'], 'write')
    folder.policy['group']['read'] = False
    folder.save()
    assert Document.objects.get(pk=doc.pk).allows(workspace['member'], 'read')


def test_inherited_file_acl_ignores_custom_checkboxes(client, workspace):
    folder = parent(workspace)
    client.force_login(workspace['admin'])
    response = client.post('/documents/new/', {
        'title': 'Inherited', 'kind': 'document', 'group': workspace['team'].pk,
        'path': '/Parent', 'content': '', **explicit(), 'permissions_mode': 'inherit',
    })
    assert response.status_code == 302
    doc = Document.objects.get(title='Inherited')
    assert doc.inherit_permissions and doc.allows(workspace['member'], 'write')
    folder.policy['group']['write'] = False
    folder.save()
    assert not Document.objects.get(pk=doc.pk).allows(workspace['member'], 'write')


def test_directory_and_upload_explicit_acl(client, workspace):
    parent(workspace)
    client.force_login(workspace['admin'])
    response = client.post('/folders/new/', {'name': 'Private', 'path': '/Parent', **explicit()})
    assert response.status_code == 302
    folder = Folder.objects.get(name='Private')
    assert not folder.inherit_permissions
    assert folder.allows(workspace['member'], 'read')
    assert not folder.allows(workspace['member'], 'write')
    response = client.post('/files/upload/', {
        'path': '/Parent', 'file': SimpleUploadedFile('private.txt', b'content'), **explicit(),
    })
    assert response.status_code == 302
    doc = Document.objects.get(title='private.txt')
    assert not doc.inherit_permissions and not doc.allows(workspace['member'], 'write')


def test_non_admin_cannot_inject_explicit_acl(client, workspace):
    parent(workspace)
    client.force_login(workspace['member'])
    response = client.post('/documents/new/', {
        'title': 'Inherited', 'kind': 'document', 'group': workspace['team'].pk,
        'path': '/Parent', 'content': '', **explicit(), 'permission_everyone_write': 'on',
    })
    assert response.status_code == 302
    doc = Document.objects.get(title='Inherited')
    assert doc.inherit_permissions
    assert not doc.allows(workspace['outsider'], 'write')


def test_invalid_permissions_mode_does_not_create_a_file(client, workspace):
    client.force_login(workspace['admin'])
    response = client.post('/documents/new/', {
        'title': 'Invalid', 'kind': 'document', 'group': workspace['team'].pk,
        'path': '/', 'content': '', 'permissions_mode': 'invalid',
    })
    assert response.status_code == 400
    assert not Document.objects.exists()
    assert not list(workspace['root'].iterdir())


def test_creation_permissions_are_translated(client, workspace):
    client.force_login(workspace['admin'])
    page = client.get('/documents/new/', HTTP_ACCEPT_LANGUAGE='ru')
    text = page.content.decode()
    assert 'Права доступа при создании' in text
    assert 'Задать собственные права' in text


def test_multiple_group_rules_survive_reload_and_moves(client, workspace):
    from django.contrib.auth.models import Group
    from wiki.folders import move_item
    reviewers = Group.objects.create(name='Reviewers')
    editors = Group.objects.create(name='Editors')
    member = workspace['member']
    member.groups.add(reviewers)
    outsider = workspace['outsider']
    outsider.groups.add(editors)
    client.force_login(workspace['admin'])
    response = client.post('/documents/new/', {
        'title': 'Shared', 'kind': 'document', 'group': workspace['team'].pk, 'path': '/',
        'content': '', **explicit(),
        f'permission_team_{reviewers.pk}_enabled': 'on',
        f'permission_team_{reviewers.pk}_visible': 'on',
        f'permission_team_{reviewers.pk}_read': 'on',
        f'permission_team_{editors.pk}_enabled': 'on',
        f'permission_team_{editors.pk}_visible': 'on',
        f'permission_team_{editors.pk}_read': 'on',
        f'permission_team_{editors.pk}_write': 'on',
    })
    assert response.status_code == 302
    doc = Document.objects.get(title='Shared')
    assert len(doc.group_policies) == 2
    assert doc.allows(member, 'read') and not doc.allows(member, 'write')
    assert doc.allows(outsider, 'write')
    member.groups.add(editors)
    assert doc.allows(member, 'write')
    destination = parent(workspace)
    destination.policy['everyone']['read'] = False
    destination.save()
    move_item(workspace['admin'], doc, destination)
    doc.refresh_from_db()
    assert doc.allows(outsider, 'write') and not doc.inherit_permissions
    page = client.get(f'/documents/{doc.pk}/permissions/')
    assert f'name="group.{editors.pk}.enabled"'.encode() in page.content
    response = client.post(f'/documents/{doc.pk}/permissions/', {
        'group': workspace['team'].pk, 'group_permissions_present': '1',
        f'group.{reviewers.pk}.enabled': 'on', f'group.{reviewers.pk}.visible': 'on',
        f'group.{reviewers.pk}.read': 'on', 'owner.visible': 'on', 'owner.read': 'on',
        'owner.write': 'on', f'group.{editors.pk}.write': 'on',
    })
    assert response.status_code == 302
    doc.refresh_from_db()
    assert str(editors.pk) not in doc.group_policies
    assert not doc.allows(outsider, 'write')


def test_explicit_deny_and_inherited_group_rules(client, workspace):
    client.force_login(workspace['admin'])
    group = workspace['team']
    response = client.post('/folders/new/', {
        'name': 'Denied', 'path': '/', **explicit(), f'permission_team_{group.pk}_enabled': 'on',
    })
    assert response.status_code == 302
    folder = Folder.objects.get(name='Denied')
    assert folder.group_policies[str(group.pk)] == {'visible': False, 'read': False, 'write': False}
    assert not folder.allows(workspace['member'], 'read')
    from wiki.services import save_document
    child = Folder.objects.create(name='Child', parent=folder, owner=workspace['admin'], group=group)
    doc = save_document(workspace['admin'], 'Inherited', 'document', 'Notes', '', group, folder=child)
    assert not doc.allows(workspace['member'], 'read')
    folder.group_policies[str(group.pk)] = {'visible': True, 'read': True, 'write': True}
    folder.save()
    assert Document.objects.get(pk=doc.pk).allows(workspace['member'], 'write')


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
