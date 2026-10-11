import json
import pytest
from django.urls import reverse
from wiki.acl import apply_api_access
from wiki.models import Folder

pytestmark = pytest.mark.django_db


def test_individual_write_implies_read_and_deny_overrides_group(document, workspace):
    user = workspace['member']
    document.inherit_permissions = False
    document.user_policies = {str(user.pk): {'read': False, 'write': True}}
    document.save()
    assert document.allows(user, 'write') and document.allows(user, 'read')
    document.user_policies[str(user.pk)] = {'read': False, 'write': False}
    document.save()
    assert not document.allows(user, 'read') and not document.allows(user, 'visible')
    assert document.allows(workspace['admin'], 'write')


def test_folder_rules_are_inherited_and_local_override_applies(document, workspace):
    folder = Folder.objects.create(name='Personal', owner=workspace['admin'], group=workspace['team'], inherit_permissions=False,
        user_policies={str(workspace['outsider'].pk): {'read': True, 'write': True}})
    document.folder = folder
    document.inherit_permissions = True
    document.save()
    assert document.allows(workspace['outsider'], 'write')
    document.inherit_permissions = False
    document.user_policies = {str(workspace['outsider'].pk): {'read': False, 'write': False}}
    document.save()
    assert not document.allows(workspace['outsider'], 'read')


def test_api_personal_grants_validate_and_are_admin_only(client, document, workspace):
    url = f'/api/docs/{document.pk}'
    client.force_login(workspace['admin'])
    payload = {'user_policies': {str(workspace['outsider'].pk): {'read': False, 'write': True}}}
    response = client.put(url, json.dumps(payload), content_type='application/json')
    assert response.status_code == 200
    document.refresh_from_db()
    assert document.user_policies[str(workspace['outsider'].pk)] == {'read': True, 'write': True}
    assert document.allows(workspace['outsider'], 'write')
    assert client.put(url, json.dumps({'user_policies': {'999999': {'read': True, 'write': False}}}), content_type='application/json').status_code == 400
    client.force_login(workspace['outsider'])
    assert client.put(url, json.dumps({'user_policies': {}}), content_type='application/json').status_code == 403


def test_settings_save_user_rules(client, document, workspace):
    client.force_login(workspace['admin'])
    user = workspace['outsider']
    response = client.post(reverse('file-settings', args=[document.pk]), {'action': 'access', 'group': document.group_id,
        f'user.{user.pk}.enabled': 'on', f'user.{user.pk}.write': 'on'})
    assert response.status_code == 302
    document.refresh_from_db()
    assert document.user_policies[str(user.pk)] == {'read': True, 'write': True}


def test_local_personal_access_keeps_parent_inheritance(client, document, workspace):
    folder=Folder.objects.create(name='Inherited with exception',owner=workspace['admin'],group=workspace['team'],inherit_permissions=False,
        user_policies={str(workspace['member'].pk):{'read':True,'write':True}})
    document.folder=folder;document.inherit_permissions=True;document.save()
    client.force_login(workspace['admin'])
    response=client.put(f'/api/docs/{document.pk}',json.dumps({'user_policies':{str(workspace['outsider'].pk):{'read':True,'write':False}}}),content_type='application/json')
    assert response.status_code==200
    document.refresh_from_db()
    assert document.inherit_permissions is True
    assert document.allows(workspace['member'],'write')
    assert document.allows(workspace['outsider'],'read')
    assert not document.allows(workspace['outsider'],'write')
