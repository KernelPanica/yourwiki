import html
import os
from urllib.parse import parse_qs,urlsplit,urlencode
import pytest
from playwright.sync_api import expect,sync_playwright
from wiki.models import Invitation

pytestmark=[pytest.mark.browser,pytest.mark.django_db(transaction=True),
    pytest.mark.skipif(os.environ.get('RUN_BROWSER')!='1',reason='Set RUN_BROWSER=1')]


@pytest.mark.parametrize('cloud_required,width',[(False,1440),(True,390)])
def test_registration_required_setup_and_provider_return(realtime_server,workspace,monkeypatch,cloud_required,width):
    from tests.test_provider_onboarding import cloud
    if cloud_required:cloud(workspace)
    invitation=Invitation.objects.create(token_hash=Invitation.digest('setup-ui'),creator=workspace['admin'])
    invitation.groups.add(workspace['team'])
    monkeypatch.setattr('wiki.identities.exchange_identity',lambda *args:{'external_id':'ui-account','email':'user@example.org','login':''})
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page=browser.new_page(viewport={'width':width,'height':900})
        def consent(route):
            query=parse_qs(urlsplit(route.request.url).query)
            callback=query['redirect_uri'][0]+'?'+urlencode({'state':query['state'][0],'code':'test-code'})
            route.fulfill(content_type='text/html',body='<a href="'+html.escape(callback,quote=True)+'">Return</a>')
        page.route('https://accounts.google.com/**',consent)
        page.goto(realtime_server+'/invite/setup-ui/')
        page.locator('[name=username]').fill('newcomer-ui')
        page.locator('[name=display_name]').fill('New member')
        for field in ('password1','password2'):page.locator(f'[name={field}]').fill('Strong-password-7462')
        page.get_by_role('button',name='Join workspace',exact=True).click()
        expect(page).to_have_url(realtime_server+'/account/setup/')
        page.goto(realtime_server+'/folders/')
        expect(page).to_have_url(realtime_server+'/account/setup/')
        assert page.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1')
        finish=page.get_by_role('button',name='Synchronize access and continue',exact=True)
        if cloud_required:
            expect(finish).to_be_disabled()
            form=page.locator('form[action$="/google/connect/"]')
            response=page.request.post(realtime_server+'/account/providers/google/connect/',form={
                'csrfmiddlewaretoken':form.locator('[name=csrfmiddlewaretoken]').input_value()},max_redirects=0)
            assert response.status==302
            page.goto(response.headers['location'])
            page.get_by_role('link',name='Return',exact=True).click()
            page.locator('[name=display_name]').fill('New member')
            page.get_by_role('button',name='Finish connecting',exact=True).click()
            expect(page).to_have_url(realtime_server+'/account/setup/')
            expect(page.get_by_text('user@example.org',exact=False)).to_be_visible()
            expect(finish).to_be_enabled()
        finish.click()
        expect(page).to_have_url(realtime_server+'/')
        browser.close()
