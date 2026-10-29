import pytest
from django.contrib.auth.models import Group
from wiki.models import Folder

pytestmark = pytest.mark.django_db


def test_member_list_has_no_group_creation_and_login_opens_files(client, workspace):
    response = client.post('/login/', {'username':'admin', 'password':'Correct-password-8923'})
    assert response.url == '/folders/'
    response = client.get('/members/')
    assert b'name="name"' not in response.content
    assert client.post('/members/', {'name':'Unexpected'}).status_code == 405
    assert not Group.objects.filter(name='Unexpected').exists()


def test_group_membership_changes_only_on_group_page(client, workspace):
    client.force_login(workspace['admin'])
    group = Group.objects.create(name='Editors')
    response = client.post(f'/groups/{group.pk}/', {'name':'Project editors','members':[workspace['member'].pk]})
    assert response.status_code == 302
    group.refresh_from_db()
    assert group.name == 'Project editors'
    assert list(group.user_set.all()) == [workspace['member']]
    response = client.post(f'/members/{workspace["member"].pk}/', {
        'display_name':'Member','is_active':'on','groups':[]})
    assert response.status_code == 302
    assert group.user_set.filter(pk=workspace['member'].pk).exists()
    response = client.post(f'/groups/{group.pk}/', {'name':'Project editors'})
    assert response.status_code == 302
    assert not group.user_set.exists()


def test_group_membership_requires_admin_and_valid_selection(client, workspace):
    group = workspace['team']
    client.force_login(workspace['member'])
    assert client.post(f'/groups/{group.pk}/', {'name':'Bad','members':[]}).status_code == 500
    client.force_login(workspace['admin'])
    before = set(group.user_set.values_list('pk',flat=True))
    assert client.post(f'/groups/{group.pk}/', {'name':'Bad','members':['999999']}).status_code == 400
    assert set(group.user_set.values_list('pk',flat=True)) == before
    group.refresh_from_db()
    assert group.name != 'Bad'


def test_group_with_folder_cannot_be_deleted(client, workspace):
    client.force_login(workspace['admin'])
    group = Group.objects.create(name='Folder owner')
    Folder.objects.create(name='Protected',owner=workspace['admin'],group=group)
    assert client.post('/groups/', {'action':'delete','group':group.pk}).status_code == 302
    assert Group.objects.filter(pk=group.pk).exists()
