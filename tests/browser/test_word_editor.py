"""DOCX/Markdown visual editing, real collaboration and portable output."""
import io
import os
import re
from pathlib import Path
import pytest
from playwright.sync_api import expect, sync_playwright
from wiki.services import save_document

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def login(page, server, username):
    page.goto(server + '/login/')
    page.get_by_label('Username').fill(username)
    page.get_by_label('Password', exact=True).fill('Correct-password-8923')
    page.get_by_role('button', name='Sign in', exact=True).click()


@pytest.mark.parametrize('file_format', ['docx', 'md'])
def test_word_gui_edits_merges_and_exports(realtime_server, workspace, file_format):
    doc = save_document(workspace['admin'], 'Office document', 'document', 'Notes',
                        'Original paragraph', workspace['team'], file_format=file_format)
    doc.inherit_permissions = False
    doc.policy['group']['write'] = True
    doc.save()
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        a = browser.new_page(viewport={'width':1440,'height':1000})
        b = browser.new_page(viewport={'width':1440,'height':1000})
        for page, username in [(a, 'admin'), (b, 'member')]:
            page.on('pageerror', lambda error: errors.append(str(error)))
            login(page, realtime_server, username)
            page.goto(realtime_server + f'/documents/{doc.pk}/live/')
            expect(page.locator('.document-host .tiptap')).to_contain_text('Original paragraph')
            expect(page.get_by_role('group', name='Formatting', exact=True)).to_be_visible()
            page.get_by_role('tab', name='Insert', exact=True).click()
            expect(page.get_by_role('group', name='Insert', exact=True)).to_be_visible()
            page.get_by_role('tab', name='Home', exact=True).click()
            expect(page.locator('#editor-error')).to_be_hidden()
        a.locator('.tiptap').click()
        a.keyboard.press('Control+End'); a.keyboard.type(' Alice')
        a.keyboard.press('Control+Shift+ArrowLeft')
        a.get_by_role('button', name='Bold', exact=True).click()
        expect(b.locator('.tiptap strong')).to_contain_text('Alice', timeout=15000)
        b.locator('.tiptap').click()
        b.keyboard.press('Control+End'); b.keyboard.type(' Bob')
        expect(a.locator('.tiptap')).to_contain_text('Bob', timeout=15000)
        a.keyboard.press('Control+End'); a.keyboard.press('Enter')
        a.get_by_role('tab', name='Insert', exact=True).click()
        a.get_by_role('button', name='Table', exact=True).click()
        expect(b.locator('.tiptap table')).to_be_visible(timeout=15000)
        a.get_by_role('button', name='Save now', exact=True).click()
        expect(a.locator('#sync-status')).to_have_text(re.compile('^(Saved|Synced) to storage$'), timeout=15000)
        export = a.request.get(realtime_server + f'/documents/{doc.pk}/export/')
        assert export.status == 200
        if file_format == 'docx':
            from docx import Document as Word
            word = Word(io.BytesIO(export.body()))
            assert any('Alice' in paragraph.text and 'Bob' in paragraph.text for paragraph in word.paragraphs)
            assert any(run.bold and 'Alice' in run.text for paragraph in word.paragraphs for run in paragraph.runs)
            assert len(word.tables) == 1
        a.reload()
        expect(a.locator('.tiptap')).to_contain_text('Bob')
        expect(a.locator('.tiptap table')).to_be_visible()
        a.get_by_role('tab', name='Home', exact=True).focus()
        a.keyboard.press('ArrowRight')
        expect(a.get_by_role('tab', name='Insert', exact=True)).to_have_attribute('aria-selected', 'true')
        a.keyboard.press('ArrowLeft')
        expect(a.get_by_role('tab', name='Home', exact=True)).to_have_attribute('aria-selected', 'true')
        output = Path('/tmp/yourwiki-word-editor'); output.mkdir(exist_ok=True)
        a.screenshot(path=str(output/f'{file_format}-desktop.png'), full_page=True)
        a.context.add_cookies([{'name':'django_language','value':'ru','url':realtime_server}])
        a.reload()
        expect(a.locator('.tiptap')).to_contain_text('Bob')
        a.screenshot(path=str(output/f'{file_format}-desktop-ru.png'), full_page=True)
        a.set_viewport_size({'width':320,'height':900})
        assert a.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        assert a.locator('.document-tool-controls').evaluate_all('elements => elements.every(e => e.scrollWidth <= e.clientWidth + 1)')
        a.screenshot(path=str(output/f'{file_format}-mobile.png'), full_page=True)
        assert not errors, errors
        browser.close()
