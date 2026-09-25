import pytest
from django.forms.models import model_to_dict
from wiki.models import SiteConfiguration, Folder

pytestmark=pytest.mark.django_db


def test_header_cleanup_and_admin_only_settings(client,workspace):
    client.force_login(workspace['member'])
    response=client.get('/')
    assert b'workspace-home" href="/folders/"' in response.content
    assert b'local-pill' not in response.content and b'avatar small' not in response.content
    assert b'welcome-banner' not in response.content and b'Site administration' not in response.content
    assert client.get('/settings/').status_code==500
    assert client.get('/account/').status_code==200
    client.force_login(workspace['admin'])
    assert b'Site administration' in client.get('/').content
    assert client.get('/settings/').status_code==200


def test_administration_persists_and_applies_settings(client,workspace):
    client.force_login(workspace['admin'])
    data=model_to_dict(SiteConfiguration.current());data.pop('default_document_policy')
    data.update(name='Engineering wiki',session_hours=6,invite_days=2,invite_uses=4)
    for action in ('visible','read','write'): data['owner.'+action]='on'
    response=client.post('/settings/',data)
    assert response.status_code==302
    assert SiteConfiguration.current().name=='Engineering wiki'
    assert b'Engineering wiki' in client.get('/').content
    client.logout();client.post('/login/',{'username':'member','password':'Correct-password-8923'})
    assert client.session.get_expiry_age()==6*3600


def test_nested_directory_navigation_hides_private_names(client,workspace):
    parent=Folder.objects.create(name='Engineering',owner=workspace['admin'],group=workspace['team'])
    child=Folder.objects.create(name='Architecture',parent=parent,owner=workspace['admin'],group=workspace['team'])
    client.force_login(workspace['member'])
    response=client.get('/')
    assert b'explorer-children' in response.content and b'Architecture' in response.content
    parent.policy['group']['visible']=False;parent.save()
    response=client.get('/')
    assert b'Architecture' not in response.content and b'Engineering' not in response.content
    child.inherit_permissions=False;child.save()
    response=client.get('/')
    assert b'Architecture' in response.content and b'Engineering' not in response.content


def test_explorer_files_and_menu_respect_permissions(client, workspace, document):
    directory = Folder.objects.create(name='Project files', owner=workspace['admin'], group=workspace['team'])
    document.folder = directory
    document.save(update_fields=['folder'])
    client.force_login(workspace['member'])
    page = client.get('/').content.decode()
    sidebar = page.split('<aside')[1].split('</aside>')[0]
    assert 'explorer-children' in sidebar and document.title in sidebar
    assert document.title in page and 'Project files' in sidebar
    assert 'Recent' not in sidebar
    menu = page.split('<details class="workspace-menu">')[1]
    assert 'Recent' in menu and 'Permissions' not in menu
    assert 'Shared with me' not in menu
    assert client.get('/permissions/').status_code == 500
    assert b'<h1>All documents</h1>' in client.get('/?section=Shared').content
    assert 'Site administration' not in menu
    directory.policy['group']['visible'] = False
    directory.save()
    # Independently shared files stay discoverable without exposing private directories.
    sidebar = client.get('/').content.decode().split('<aside')[1].split('</aside>')[0]
    assert 'Project files' not in sidebar and document.title in client.get('/').content.decode()
    document.policy['group']['visible'] = False
    document.save()
    assert document.title.encode() not in client.get('/').content
