import pytest
from wiki.models import SiteConfiguration, ProviderIdentity
from wiki.crypto import encrypt

@pytest.fixture
def oauth(workspace,client):
    SiteConfiguration.objects.create(encrypted_identity_oauth_clients=encrypt({'google':{'client_id':'client','client_secret':'secret'}}))
    client.force_login(workspace['member'])
    return client

def test_link_requires_matching_one_time_state(oauth,workspace,monkeypatch):
    from urllib.parse import urlsplit,parse_qs
    response=oauth.post('/account/providers/google/connect/')
    assert response.status_code==302
    state=parse_qs(urlsplit(response.url).query)['state'][0]
    exchange=__import__('unittest.mock',fromlist=['Mock']).Mock(return_value={'external_id':'subject','email':'verified@example.org','login':''})
    monkeypatch.setattr('wiki.identities.exchange_identity',exchange)
    assert oauth.post('/account/providers/google/callback/',{'state':'wrong','code':'code'}).status_code==403
    exchange.assert_not_called()
    response=oauth.post('/account/providers/google/callback/',{'state':state,'code':'code','display_name':'Member'})
    assert response.status_code==302
    assert ProviderIdentity.objects.get(user=workspace['member']).email=='verified@example.org'
    assert oauth.post('/account/providers/google/callback/',{'state':state,'code':'code','display_name':'Member'}).status_code==400
    assert exchange.call_count==1

def test_get_callback_never_links(oauth,monkeypatch):
    def no(*args):raise AssertionError('Must not exchange')
    monkeypatch.setattr('wiki.identities.exchange_identity',no)
    assert oauth.get('/account/providers/google/callback/?code=c&state=s').status_code==200
    assert not ProviderIdentity.objects.exists()

def test_oauth_client_config_admin_only(oauth,workspace):
    assert oauth.post('/account/providers/',{'provider':'google','client_id':'evil','client_secret':'evil'}).status_code==403

def test_identity_cannot_be_claimed_by_two_users(oauth,workspace,monkeypatch):
    from urllib.parse import urlsplit,parse_qs
    ProviderIdentity.objects.create(user=workspace['outsider'],provider='google',external_id='taken',email='same@example.org')
    monkeypatch.setattr('wiki.identities.exchange_identity',lambda *args: {'external_id':'taken','email':'same@example.org','login':''})
    response=oauth.post('/account/providers/google/connect/')
    state=parse_qs(urlsplit(response.url).query)['state'][0]
    assert oauth.post('/account/providers/google/callback/',{'state':state,'code':'code','display_name':'Member'}).status_code==400
    assert not ProviderIdentity.objects.filter(user=workspace['member']).exists()

def test_expired_oauth_state_is_consumed(oauth,monkeypatch):
    from wiki.crypto import decrypt,encrypt
    oauth.post('/account/providers/google/connect/')
    session=oauth.session;pending=decrypt(session['identity_oauth_google']);pending['created']-=601
    session['identity_oauth_google']=encrypt(pending);session.save()
    def forbidden(*args):raise AssertionError('Expired state must not exchange')
    monkeypatch.setattr('wiki.identities.exchange_identity',forbidden)
    response=oauth.post('/account/providers/google/callback/',{'state':pending['state'],'code':'c','display_name':'Member'})
    assert response.status_code==400 and 'identity_oauth_google' not in oauth.session

def test_google_identity_rejects_unverified_email(monkeypatch):
    from wiki.identities import exchange_identity
    from django.core.exceptions import ValidationError
    from unittest.mock import Mock
    replies=[Mock(json=lambda:{'access_token':'secret'}),Mock(json=lambda:{'sub':'123','email':'unverified@example.org','email_verified':False})]
    monkeypatch.setattr('wiki.identities.HTTP.request',Mock(side_effect=replies))
    with pytest.raises(ValidationError,match='verified'):
        exchange_identity('google',{'config':{'client_id':'c','client_secret':'s'},'redirect_uri':'https://wiki.example/callback','verifier':'v'},'c')
