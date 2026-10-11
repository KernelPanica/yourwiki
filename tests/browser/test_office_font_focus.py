import os
import pytest
from playwright.sync_api import sync_playwright, expect
from tests.browser.test_word_editor import login

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True), pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_font_commit_returns_input_but_search_and_readonly_keep_focus(realtime_server,workspace):
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page=browser.new_page()
        login(page,realtime_server,'admin')
        page.add_script_tag(url=realtime_server+'/static/wiki/office-font-focus.js')
        page.evaluate('''() => {
          const frame=document.createElement('iframe');frame.id='focus-test';document.getElementById('main-content').append(frame);
          frame.contentDocument.body.innerHTML='<div class="ui-combobox" id="fontnamecombobox"><input id="font-input"></div><div id="fontnamecombobox-dropdown" class="modalpopup"><input class="ui-combobox-search-input" id="font-search"><button id="fontnamecombobox-entry-1">Anton</button></div><input id="other-control"><div id="editor-content" contenteditable="true"></div>';
          window.focusCalls=0;
          window.detachFont=yourwikiOfficeFontFocus.attach(frame,()=>{focusCalls++;frame.contentDocument.getElementById('editor-content').focus();},true);
        }''')
        frame=page.frame_locator('#focus-test')
        field=frame.locator('#font-input')
        content=frame.locator('#editor-content')
        field.fill('Anton');field.press('Enter')
        expect(content).to_be_focused()
        page.keyboard.type('Typed after font selection')
        expect(content).to_have_text('Typed after font selection')
        search=frame.locator('#font-search')
        search.fill('An')
        expect(search).to_be_focused()
        frame.locator('#fontnamecombobox-entry-1').click()
        expect(content).to_be_focused()
        search.fill('Ti');search.press('Enter')
        expect(content).to_be_focused()
        frame.locator('#other-control').fill('Other setting')
        expect(frame.locator('#other-control')).to_be_focused()
        page.evaluate('detachFont();window.detachFont=yourwikiOfficeFontFocus.attach(document.getElementById("focus-test"),()=>{focusCalls++;},false)')
        count=page.evaluate('focusCalls')
        field.fill('Readonly');field.press('Enter')
        expect(field).to_be_focused()
        assert page.evaluate('focusCalls')==count
        browser.close()
