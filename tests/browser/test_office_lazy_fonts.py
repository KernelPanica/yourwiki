import os
import pytest
from playwright.sync_api import sync_playwright, expect
from tests.browser.test_word_editor import login

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True), pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_add_font_is_inside_code_lazy_and_preserves_document(realtime_server, workspace):
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page()
        login(page, realtime_server, 'admin')
        page.goto(realtime_server+'/')
        page.wait_for_selector('#main-content')
        requests = []
        def catalogue(route):
            requests.append('catalogue')
            route.fulfill(json={'families':[{'name':'Anton','fonts':[]}]})
        def activate(route):
            requests.append(route.request.post_data)
            route.fulfill(json={'name':'Anton','created':True,'refresh_seconds':60})
        page.route('**/office/google-fonts.json', catalogue)
        page.route('**/office/fonts/activate/', activate)
        page.evaluate('''() => {
          const main=document.getElementById('main-content');
          main.innerHTML='<form id="office-heartbeat"><input name="csrfmiddlewaretoken" value="test"></form><iframe id="office-frame" data-document="test-id"></iframe>';
          document.getElementById('office-frame').contentDocument.body.innerHTML='<div id="fontnamecombobox-dropdown" class="modalpopup"></div><textarea id="test-document">Unsaved text</textarea>';
        }''')
        page.add_script_tag(url=realtime_server+'/static/wiki/office-fonts.js')
        page.evaluate('window.detachFontCatalogue=yourwikiOfficeFonts.attach(document.getElementById("office-frame"),true);void 0')
        assert requests == []
        frame=page.frame_locator('#office-frame')
        frame.get_by_role('button',name='Add font…').click()
        expect(frame.get_by_role('dialog',name='Добавить шрифт')).to_be_visible()
        expect(frame.locator('option[value="Anton"]')).to_have_count(1)
        frame.get_by_label('Название шрифта').fill('Anton')
        original_url = page.url
        frame.get_by_role('button',name='Подключить',exact=True).click()
        expect(frame.get_by_role('status')).to_contain_text('Anton: сервер подключит')
        assert page.url == original_url
        expect(frame.locator('#test-document')).to_have_value('Unsaved text')
        assert 'name="name"\r\n\r\nAnton' in requests[-1]
        frame.get_by_role('button',name='Закрыть',exact=True).click()
        expect(frame.get_by_role('dialog')).to_have_count(0)
        # Rebuilt notebookbar dropdowns receive exactly one action.
        page.evaluate('''() => {
          const doc=document.getElementById('office-frame').contentDocument;
          doc.querySelector('.modalpopup').remove();
          const popup=doc.createElement('div');popup.id='fontnamecombobox-new';popup.className='modalpopup';doc.body.append(popup);
        }''')
        expect(frame.get_by_role('button',name='Add font…')).to_have_count(1)
        page.evaluate('detachFontCatalogue();window.detachFontCatalogue=yourwikiOfficeFonts.attach(document.getElementById("office-frame"),false);void 0')
        expect(frame.get_by_role('button',name='Add font…')).to_have_count(0)
        browser.close()
