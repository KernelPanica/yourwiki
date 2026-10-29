from urllib.parse import parse_qs,urlsplit
import pytest
from django.urls import reverse
from wiki.crypto import encrypt
from wiki.models import Invitation,User,ProviderIdentity,ProviderGrant,SiteConfiguration

pytestmark=pytest.mark.django_db


def register(client,workspace):
    invitation=Invitation.objects.create(token_hash=Invitation.digest('onboard'),creator=workspace['admin'])
    invitation.groups.add(workspace['team'])
    return client.post('/invite/onboard/',{'username':'newcomer','display_name':'New member',
        'password1':'Strong-password-7456','password2':'Strong-password-7456'})


def cloud(workspace,provider='google'):
    from wiki.storage import root_mount
    mount=root_mount();mount.provider=provider
    mount.encrypted_config=encrypt({'provider':provider,'root':'root'})
    mount.save()
    SiteConfiguration.objects.update_or_create(pk=1,defaults={'encrypted_identity_oauth_clients':encrypt({provider:{'client_id':'c','client_secret':'s'}})})
    return mount


def test_registration_redirects_to_persistent_required_setup(client,workspace):
    response=register(client,workspace)
    assert response.status_code==302 and response.url=='/account/setup/'
    user=User.objects.get(username='newcomer')
    assert user.provider_setup_required
    assert client.get('/folders/').url=='/account/setup/'
    assert client.get('/api/folders').status_code==403
    client.logout();client.force_login(user)
    assert client.get('/').url=='/account/setup/'
    assert client.post('/logout/').status_code==302


def test_local_setup_explains_no_oauth_and_finishes(client,workspace):
    register(client,workspace)
    response=client.get('/account/setup/')
    assert response.status_code==200 and b'Local' in response.content
    response=client.post('/account/setup/')
    assert response.status_code==302 and response.url=='/'
    assert not User.objects.get(username='newcomer').provider_setup_required


def test_cloud_setup_cannot_be_skipped_or_completed_without_identity(client,workspace):
    cloud(workspace);register(client,workspace)
    response=client.get('/account/setup/')
    assert b'Google Drive' in response.content
    assert client.post('/account/setup/').status_code==400
    assert client.get('/account/providers/').url=='/account/setup/'
    assert client.get('/account/providers/google/connect/').status_code==405
    assert User.objects.get(username='newcomer').provider_setup_required


def test_oauth_returns_to_required_setup_and_successful_grants_unlock(client,workspace,monkeypatch):
    cloud(workspace);register(client,workspace)
    response=client.post('/account/providers/google/connect/')
    state=parse_qs(urlsplit(response.url).query)['state'][0]
    monkeypatch.setattr('wiki.identities.exchange_identity',lambda *args:{'external_id':'new-id','email':'verified@example.org','login':''})
    response=client.post('/account/providers/google/callback/',{'state':state,'code':'c','display_name':'New member'})
    assert response.status_code==302 and response.url=='/account/setup/'
    calls=[]
    monkeypatch.setattr('wiki.identities.enqueue_sync',lambda **kwargs:calls.append(kwargs))
    from wiki.models import ProviderSyncState
    ProviderSyncState.objects.create(pk=1,requested_revision=1,completed_revision=1)
    assert client.post('/account/setup/').url=='/'
    assert not calls and ProviderIdentity.objects.get(user__username='newcomer').email=='verified@example.org'


@pytest.mark.parametrize('status',['failed','pending'])
def test_failed_grant_keeps_setup_required(client,workspace,document,monkeypatch,status):
    mount=cloud(workspace);register(client,workspace)
    user=User.objects.get(username='newcomer')
    ProviderIdentity.objects.create(user=user,provider='google',external_id='id',email='member@example.org')
    ProviderGrant.objects.create(user=user,mount=mount,provider='google',object_key='key',reference=document.reference,
        desired_role='read',status=status,error='Provider synchronization failed.')
    monkeypatch.setattr('wiki.identities.enqueue_sync',lambda **kwargs:None)
    response=client.post('/account/setup/')
    assert response.status_code==302 and response.url=='/account/setup/'
    assert User.objects.get(pk=user.pk).provider_setup_required


def test_existing_admin_can_configure_oauth_during_setup(client,workspace):
    cloud(workspace);client.force_login(workspace['admin'])
    assert client.get('/account/providers/').status_code==200


@pytest.mark.parametrize('write',[False,True])
def test_setup_applies_actual_rw_grants_before_unlocking(client,workspace,document,monkeypatch,write):
    from types import SimpleNamespace
    cloud(workspace)
    document.policy['group']['write']=write;document.save()
    register(client,workspace)
    user=User.objects.get(username='newcomer')
    ProviderIdentity.objects.create(user=user,provider='google',external_id='id',email='verified@example.org')
    calls=[]
    def set_grant(reference,recipient,role,permission):
        calls.append((reference,recipient,role));return 'personal-permission'
    monkeypatch.setattr('wiki.provider_grants.mount_adapter',lambda mount:SimpleNamespace(set_grant=set_grant))
    response=client.post('/account/setup/')
    assert response.status_code==302 and response.url=='/account/setup/'
    assert User.objects.get(pk=user.pk).provider_setup_required
    from wiki.provider_grants import process_pending
    assert process_pending()
    assert client.post('/account/setup/').url=='/'
    grant=ProviderGrant.objects.get(user=user,provider='google')
    assert grant.status=='synced' and grant.applied_role==('write' if write else 'read')
    assert calls==[(document.reference,'verified@example.org',grant.applied_role)]


def test_unfinished_setup_blocks_websocket_authentication(client,workspace,document,settings,monkeypatch):
    from wiki.realtime import authenticate
    monkeypatch.setattr('wiki.realtime.close_old_connections',lambda:None)
    register(client,workspace)
    scope={'headers':[(b'origin',settings.PUBLIC_URL.encode()),
        (b'cookie',f'{settings.SESSION_COOKIE_NAME}={client.session.session_key}'.encode())]}
    with pytest.raises(ValueError,match='setup required'):
        authenticate(scope,str(document.pk))


def test_every_accessible_cloud_provider_is_required(client,workspace,monkeypatch):
    from wiki.models import Folder,MountPoint
    cloud(workspace)
    folder=Folder.objects.create(name='Shared',owner=workspace['admin'],group=workspace['team'])
    MountPoint.objects.create(path='/Shared',folder=folder,provider='onedrive',encrypted_config=encrypt({'root':'other'}))
    register(client,workspace)
    user=User.objects.get(username='newcomer')
    ProviderIdentity.objects.create(user=user,provider='google',external_id='google-id',email='verified@example.org')
    assert client.post('/account/setup/').status_code==400
    ProviderIdentity.objects.create(user=user,provider='onedrive',external_id='microsoft-id',email='verified@example.org')
    from wiki.models import ProviderSyncState
    ProviderSyncState.objects.update_or_create(pk=1,defaults={'requested_revision':1,'completed_revision':1})
    monkeypatch.setattr('wiki.identities.enqueue_sync',lambda **kwargs:None)
    assert client.post('/account/setup/').url=='/'


def test_cloud_setup_waits_without_blocking_request(client,workspace,django_capture_on_commit_callbacks):
    from unittest.mock import patch
    from wiki.models import ProviderSyncState
    cloud(workspace);register(client,workspace)
    user=User.objects.get(username='newcomer')
    with django_capture_on_commit_callbacks(execute=True):
        ProviderIdentity.objects.create(user=user,provider='google',external_id='new-id',email='verified@example.org')
    with patch('wiki.provider_grants.reconcile') as network:
        response=client.post('/account/setup/')
        assert response.status_code==302 and response.url=='/account/setup/'
        network.assert_not_called()
    assert User.objects.get(pk=user.pk).provider_setup_required
    assert client.get('/account/setup/status/').json()['pending']
    page=client.get('/account/setup/');assert b'provider-sync-progress' in page.content
    state=ProviderSyncState.objects.get(pk=1);state.completed_revision=state.requested_revision;state.save()
    assert client.get('/account/setup/status/').json()['ready']
    assert client.post('/account/setup/').url=='/'
