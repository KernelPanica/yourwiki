import html
import os
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlencode, urlsplit

import pytest
from playwright.sync_api import expect, sync_playwright

from wiki.crypto import decrypt, encrypt
from wiki.models import MountPoint, SiteConfiguration

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_google_return_with_strict_session_cookie(realtime_server, workspace):
    site = SiteConfiguration.current()
    site.encrypted_google_oauth_client = encrypt({'client_id': 'client-id', 'client_secret': 'secret-not-in-browser'})
    site.save()
    token = Mock(status_code=200)
    token.json.return_value = {'refresh_token': 'received-refresh-token'}
    with sync_playwright() as p, patch('install.requests.post', return_value=token) as exchange, patch('wiki.mounts.SafeAdapter'):
        browser = p.chromium.launch()
        page = browser.new_page()
        def google_consent(route):
            query = parse_qs(urlsplit(route.request.url).query)
            callback = query['redirect_uri'][0] + '?' + urlencode({'state': query['state'][0], 'code': 'code-from-google'})
            route.fulfill(content_type='text/html', body='<a href="' + html.escape(callback, quote=True) + '">Return to wiki</a>')
        page.route('https://accounts.google.com/**', google_consent)
        page.goto(realtime_server + '/login/')
        page.get_by_label('Username').fill('admin')
        page.get_by_label('Password', exact=True).fill('Correct-password-8923')
        page.get_by_role('button', name='Sign in', exact=True).click()
        page.goto(realtime_server + '/mounts/?provider=google')
        page.get_by_label('Mount path').fill('/Google')
        page.get_by_label('Drive folder ID').fill('folder-id')
        expect(page.get_by_label('Use the Google OAuth client saved during installation')).to_be_checked()
        assert 'secret-not-in-browser' not in page.content()
        expect(page.get_by_role('button', name='Connect with Google', exact=True)).to_be_visible()
        # Intercept the initial provider navigation: Playwright does not route
        # subsequent URLs in a server redirect chain. Never contact real Google.
        response = page.request.post(realtime_server + '/mounts/', form={
            'provider': 'google', 'path': '/Google', 'root': 'folder-id', 'use_saved_client': 'on',
            'csrfmiddlewaretoken': page.locator('form[autocomplete=off] input[name=csrfmiddlewaretoken]').input_value(),
        }, max_redirects=0)
        assert response.status == 302
        page.goto(response.headers['location'])
        expect(page.get_by_role('link', name='Return to wiki')).to_be_visible()
        with page.expect_request(lambda req: '/mounts/google/callback/?' in req.url) as returned:
            page.get_by_role('link', name='Return to wiki').click()
        assert 'sessionid=' not in returned.value.all_headers().get('cookie', '')
        expect(page.get_by_role('button', name='Finish connecting', exact=True)).to_be_visible()
        exchange.assert_not_called()
        page.get_by_role('button', name='Finish connecting', exact=True).click()
        expect(page).to_have_url(realtime_server + '/mounts/')
        expect(page.locator('.mount-card h2').filter(has_text='/Google')).to_be_visible()
        exchange.assert_called_once()
        browser.close()
    assert decrypt(MountPoint.objects.get(path='/Google').encrypted_config)['refresh_token'] == 'received-refresh-token'
