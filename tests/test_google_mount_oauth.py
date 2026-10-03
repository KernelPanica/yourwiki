import base64
import hashlib
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

import pytest
from django.contrib.sessions.models import Session
from django.test import Client

from wiki.crypto import decrypt, encrypt
from wiki.models import MountPoint, SiteConfiguration
from wiki.storage import StorageError

pytestmark = pytest.mark.django_db
CALLBACK = '/mounts/google/callback/'


def start(client, workspace, saved=False, root='folder-id'):
    client.force_login(workspace['admin'])
    data = {'provider': 'google', 'path': '/Google', 'root': root}
    if saved:
        site = SiteConfiguration.current()
        site.encrypted_google_oauth_client = encrypt({'client_id': 'saved-id', 'client_secret': 'private-client-secret'})
        site.save()
        data['use_saved_client'] = 'on'
    else:
        data.update(client_id='manual-id', client_secret='private-client-secret')
    response = client.post('/mounts/', data)
    assert response.status_code == 302
    url = urlsplit(response['Location'])
    assert url.hostname == 'accounts.google.com'
    query = parse_qs(url.query)
    pending = decrypt(client.session['google_mount_oauth'])
    assert query['access_type'] == ['offline']
    assert query['prompt'] == ['consent']
    assert query['code_challenge_method'] == ['S256']
    assert query['code_challenge'] == [base64.urlsafe_b64encode(hashlib.sha256(pending['verifier'].encode()).digest()).rstrip(b'=').decode()]
    assert query['redirect_uri'][0].endswith(CALLBACK)
    assert 'private-client-secret' not in response['Location']
    assert 'private-client-secret' not in str(Session.objects.get(session_key=client.session.session_key).get_decoded())
    return pending


@pytest.mark.parametrize('saved', [True, False])
def test_connect_google_gets_token_and_keeps_secrets_server_side(client, workspace, saved):
    pending = start(client, workspace, saved=saved)
    html = client.get('/mounts/?provider=google').content.decode()
    assert 'name="refresh_token"' not in html
    assert 'private-client-secret' not in html
    assert ('name="use_saved_client"' in html) is saved
    # Callback landing page works without Strict session cookies and never calls Google.
    with patch('install.requests.post') as post:
        response = Client().get(CALLBACK, {'state': pending['state'], 'code': 'authorization-code'})
        assert response.status_code == 200
        assert response['Referrer-Policy'] == 'strict-origin'
        assert response['Cache-Control'] == 'no-store'
        assert b'Finish connecting' in response.content
        post.assert_not_called()
    token_response = Mock(status_code=200)
    token_response.json.return_value = {'refresh_token': 'private-refresh-token'}
    with patch('install.requests.post', return_value=token_response) as post, patch('wiki.mounts.SafeAdapter') as adapter:
        response = client.post(CALLBACK, {'state': pending['state'], 'code': 'authorization-code'})
        assert response.status_code == 302
        adapter.return_value.probe.assert_called_once()
        sent = post.call_args.kwargs
        assert sent['data']['code_verifier'] == pending['verifier']
        assert sent['data']['client_id'] == ('saved-id' if saved else 'manual-id')
        assert sent['data']['redirect_uri'] == pending['redirect_uri']
        assert sent['allow_redirects'] is False
        post.reset_mock()
        assert client.post(CALLBACK, {'state': pending['state'], 'code': 'authorization-code'}).status_code == 400
        post.assert_not_called()
    mount = MountPoint.objects.get(path='/Google')
    assert 'private-refresh-token' not in mount.encrypted_config
    assert decrypt(mount.encrypted_config)['refresh_token'] == 'private-refresh-token'
    assert 'google_mount_oauth' not in client.session


def test_google_flow_rejects_state_session_expiry_and_csrf(client, workspace):
    pending = start(client, workspace)
    data = {'state': pending['state'], 'code': 'code'}
    with patch('install.requests.post') as post:
        assert Client().post(CALLBACK, data).status_code == 500
        other = Client(); other.force_login(workspace['admin'])
        assert other.post(CALLBACK, data).status_code == 400
        assert client.post(CALLBACK, {**data, 'state': 'wrong'}).status_code == 500
        csrf = Client(enforce_csrf_checks=True); csrf.force_login(workspace['admin'])
        assert csrf.post(CALLBACK, data).status_code in (403, 500)
        pending['created'] -= 601
        session = client.session; session['google_mount_oauth'] = encrypt(pending); session.save()
        assert client.post(CALLBACK, data).status_code == 400
        post.assert_not_called()
    assert not MountPoint.objects.filter(path='/Google').exists()


@pytest.mark.parametrize('failure', ['denied', 'missing_token', 'probe'])
def test_failed_google_auth_does_not_create_mount(client, workspace, failure):
    pending = start(client, workspace)
    response = Mock(status_code=400 if failure == 'denied' else 200)
    response.json.return_value = {} if failure == 'missing_token' else {'refresh_token': 'token'}
    with patch('install.requests.post', return_value=response), patch('wiki.mounts.SafeAdapter') as adapter:
        if failure == 'probe':
            adapter.return_value.probe.side_effect = StorageError('offline')
        result = client.post(CALLBACK, {'state': pending['state'], 'code': 'code'})
        assert result.status_code in (400, 503)
    assert not MountPoint.objects.filter(path='/Google').exists()
    assert 'google_mount_oauth' not in client.session
    assert b'private-client-secret' not in result.content


def test_google_creation_and_admin_revocation(client, workspace):
    pending = start(client, workspace, root='')
    def create_folder(name):
        assert name == 'Google'
        config['root'] = 'new-folder'
    with patch('install.exchange_code') as exchange, patch('wiki.mounts.SafeAdapter') as adapter:
        exchange.side_effect = lambda config, *args: config.update(refresh_token='token')
        def wrap(raw):
            nonlocal config
            config = raw.config
            return adapter.return_value
        config = {}
        adapter.side_effect = wrap
        adapter.return_value.create_root.side_effect = create_folder
        assert client.post(CALLBACK, {'state': pending['state'], 'code': 'code'}).status_code == 302
    assert decrypt(MountPoint.objects.get(path='/Google').encrypted_config)['root'] == 'new-folder'
    client.force_login(workspace['member'])
    with patch('install.requests.post') as post:
        assert client.post('/mounts/', {'provider': 'google'}).status_code == 500
        assert client.post(CALLBACK, {'state': pending['state'], 'code': 'code'}).status_code == 500
        post.assert_not_called()


def test_saved_client_requires_explicit_selection(client, workspace):
    start(client, workspace, saved=True)
    # No fallback to a saved secret when the administrator chooses manual credentials.
    response = client.post('/mounts/', {'provider': 'google', 'path': '/Manual', 'client_id': 'another-id'})
    assert response.status_code == 400
    assert b'private-client-secret' not in response.content
