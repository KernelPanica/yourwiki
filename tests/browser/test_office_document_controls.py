"""Office controls must change the document and survive native DOCX export."""
import io
import os
import re
import pytest
from playwright.sync_api import expect, sync_playwright
from wiki.services import save_document
from tests.browser.test_word_editor import login

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_document_fonts_headings_spacing_and_mobile(realtime_server, workspace):
    doc = save_document(workspace['admin'], 'Formatting controls', 'document', 'Notes',
                        'Formatted paragraph', workspace['team'], file_format='docx')
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width':1440, 'height':1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        login(page, realtime_server, 'admin')
        page.goto(realtime_server + f'/documents/{doc.pk}/live/')
        content = page.locator('.tiptap')
        expect(content).to_contain_text('Formatted paragraph')
        content.click()
        page.keyboard.press('Control+Home')
        page.keyboard.press('Control+Shift+End')
        page.get_by_label('Font', exact=True).select_option('Times New Roman')
        page.get_by_label('Size', exact=True).select_option('18pt')
        page.get_by_label('Style', exact=True).select_option('4')
        page.get_by_label('Align', exact=True).select_option('center')
        page.get_by_label('Line spacing', exact=True).select_option('2')
        expect(content.locator('h4')).to_contain_text('Formatted paragraph')
        expect(content.locator('h4')).to_have_css('text-align', 'center')
        expect(content.locator('span').first).to_have_css('font-size', '24px')
        page.get_by_role('button', name='Save now', exact=True).click()
        expect(page.locator('#sync-status')).to_have_text(re.compile('^(Saved|Synced) to storage$'), timeout=20000)
        export = page.request.get(realtime_server + f'/documents/{doc.pk}/export/')
        assert export.status == 200
        from docx import Document
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        word = Document(io.BytesIO(export.body()))
        paragraph = next(par for par in word.paragraphs if 'Formatted paragraph' in par.text)
        assert paragraph.style.name == 'Heading 4'
        assert paragraph.alignment == WD_ALIGN_PARAGRAPH.CENTER
        assert paragraph.paragraph_format.line_spacing == 2
        assert any(run.font.name == 'Times New Roman' and run.font.size.pt == 18 for run in paragraph.runs)
        page.reload()
        expect(content.locator('h4')).to_contain_text('Formatted paragraph')
        page.screenshot(path='/tmp/yourwiki-office-doc-desktop.png', full_page=True)
        page.context.add_cookies([{'name':'django_language','value':'ru','url':realtime_server}])
        page.reload()
        expect(page.get_by_label('Межстрочный интервал', exact=True)).to_be_visible()
        page.set_viewport_size({'width':390, 'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.screenshot(path='/tmp/yourwiki-office-doc-mobile.png', full_page=True)
        assert not errors, errors
        browser.close()
