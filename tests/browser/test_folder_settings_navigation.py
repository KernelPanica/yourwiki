import os
import pytest
from playwright.sync_api import expect,sync_playwright
from wiki.models import Folder
from tests.browser.test_word_editor import login

pytestmark=[pytest.mark.browser,pytest.mark.django_db(transaction=True),pytest.mark.skipif(os.environ.get('RUN_BROWSER')!='1',reason='Set RUN_BROWSER=1')]


@pytest.mark.parametrize('width',[1440,390])
def test_folder_and_root_settings_visible_on_desktop_and_mobile(realtime_server,workspace,width):
    folder=Folder.objects.create(name='Navigation folder',owner=workspace['admin'],group=workspace['team'])
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page=browser.new_page(viewport={'width':width,'height':900})
        login(page,realtime_server,'admin')
        page.goto(realtime_server+'/folders/')
        expect(page.locator('.root-settings-link')).to_be_visible()
        expect(page.get_by_role('link',name='Settings for Navigation folder',exact=True)).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
        page.locator('.root-settings-link').click()
        expect(page).to_have_url(realtime_server+'/settings/#access')
        expect(page.locator('#access')).to_be_visible()
        expect(page.locator('input[name="group.read"]')).to_be_visible()
        page.goto(realtime_server+f'/folders/{folder.pk}/')
        expect(page.locator('.heading-actions .folder-settings-link')).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
        page.locator('.folder-settings-link').click()
        expect(page.locator('#access')).to_be_visible()
        expect(page.get_by_role('button',name='Save permissions',exact=True)).to_be_visible()
        page.screenshot(path=f'/tmp/yourwiki-folder-settings-{width}.png')
        browser.close()
