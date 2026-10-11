import pytest
from wiki.models import Folder

pytestmark=pytest.mark.django_db


def test_root_has_visible_permission_settings_link(client,workspace):
    client.force_login(workspace['admin'])
    response=client.get('/folders/')
    assert response.status_code==200
    assert 'class="button root-settings-link"' in response.content.decode()
    assert 'href="/settings/#access"' in response.content.decode()
    assert b'id="access"' in client.get('/settings/').content


def test_folder_settings_are_in_heading_and_child_actions(client,workspace):
    parent=Folder.objects.create(name='Parent',owner=workspace['admin'],group=workspace['team'])
    child=Folder.objects.create(name='Child',parent=parent,owner=workspace['admin'],group=workspace['team'])
    client.force_login(workspace['admin'])
    content=client.get(f'/folders/{parent.pk}/').content.decode()
    assert 'heading-actions' in content
    assert content.index('heading-actions')<content.index('folder-settings-link')
    assert f'/folders/{child.pk}/file-settings/' in content
    assert client.get(f'/folders/{parent.pk}/file-settings/').status_code==200


def test_non_admin_cannot_change_root_permissions(client,workspace):
    client.force_login(workspace['member'])
    assert b'root-settings-link' not in client.get('/folders/').content
    assert client.get('/settings/').status_code==500  # Existing site-wide denial contract.
