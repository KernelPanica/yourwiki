import os
import pytest
from playwright.sync_api import sync_playwright, expect
from tests.browser.test_word_editor import login
from wiki.services import save_document

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]

@pytest.mark.parametrize('width', [1440,390])
def test_trash_restore_and_local_fonts(realtime_server, workspace, width):
    doc = save_document(workspace['admin'], 'Trash browser document', 'document', 'Notes', 'Hello', workspace['team'])
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width':width,'height':900})
        login(page, realtime_server, 'admin')
        page.goto(realtime_server+f'/documents/{doc.pk}/delete/')
        page.get_by_role('button', name='Move to trash', exact=True).click()
        page.wait_for_url(realtime_server+'/')
        page.goto(realtime_server+'/trash/')
        expect(page.get_by_role('heading',name='Trash browser document')).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.screenshot(path=f'/tmp/yourwiki-trash-{width}.png')
        page.get_by_role('button', name='Restore', exact=True).click()
        expect(page.locator('main')).to_contain_text('Trash is empty.')
        page.goto(realtime_server+f'/documents/{doc.pk}/live/')
        font = page.get_by_label('Font', exact=True)
        font.select_option('Tinos')
        assert font.locator('option[value=Oswald]').count() == 1
        assert page.evaluate("async () => {await document.fonts.load('16px Tinos'); await document.fonts.load('16px Oswald'); return document.fonts.check('16px Tinos') && document.fonts.check('16px Oswald')}")
        assert page.evaluate("async () => {for (const family of ['Tinos','Oswald','Anton','Roboto','Open Sans','Arimo','Cousine']) {await document.fonts.load('16px \"'+family+'\"', 'ЁёЖжЙйПривет'); if (!document.fonts.check('16px \"'+family+'\"', 'ЁёЖжЙйПривет')) return false;} return true;}")
        browser.close()
