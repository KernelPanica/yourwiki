import os
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright, expect

pytestmark=[pytest.mark.browser,pytest.mark.django_db(transaction=True),pytest.mark.skipif(os.environ.get('RUN_BROWSER')!='1',reason='Set RUN_BROWSER=1')]

def test_provider_account_settings_layout(realtime_server,workspace):
    output=Path('/tmp/yourwiki-rw');output.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page=browser.new_page(viewport={'width':1440,'height':1000})
        errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto(realtime_server+'/login/')
        page.get_by_label('Username').fill('admin');page.get_by_label('Password',exact=True).fill('Correct-password-8923')
        page.get_by_role('button',name='Sign in',exact=True).click()
        page.goto(realtime_server+'/account/providers/')
        page.get_by_text('Configure OAuth clients',exact=True).click()
        page.locator('[name="client_id"]').fill('test-client')
        page.locator('[name="client_secret"]').fill('never-render-this-secret')
        page.get_by_role('button',name='Save',exact=True).click()
        expect(page.get_by_role('button',name='Connect account',exact=True)).to_have_count(1)
        assert 'never-render-this-secret' not in page.content()
        for width in [1440,768,390,320]:
            page.set_viewport_size({'width':width,'height':1000})
            page.locator('details.settings-card').evaluate('(el)=>el.open=true')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            page.screenshot(path=str(output/f'providers-{width}.png'),full_page=True)
        for language in ['ru','es']:
            page.context.add_cookies([{'name':'django_language','value':language,'url':realtime_server}])
            page.reload()
            for width in [1440,768,390,320]:
                page.set_viewport_size({'width':width,'height':1000})
                page.locator('details.settings-card').evaluate('(el)=>el.open=true')
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                page.screenshot(path=str(output/f'providers-{language}-{width}.png'),full_page=True)
        page.context.add_cookies([{'name':'django_language','value':'en','url':realtime_server}])
        page.goto(realtime_server+'/account/providers/google/callback/?state=test&code=test')
        expect(page.get_by_label('Display name')).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        assert not errors
        browser.close()
