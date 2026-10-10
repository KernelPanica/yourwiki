import os
import re

import pytest
from playwright.sync_api import expect, sync_playwright

from wiki.services import save_document
from tests.browser.test_word_editor import login

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_document_pages_preserve_long_paragraph_and_reflow(realtime_server, workspace):
    text = ' '.join(f'word{i}' for i in range(1800))
    doc = save_document(workspace['admin'], 'Paginated document', 'document', 'Notes',
                        text, workspace['team'], file_format='docx')
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        login(page, realtime_server, 'admin')
        page.goto(realtime_server + f'/documents/{doc.pk}/live/')
        paper = page.locator('.tiptap')
        expect(paper).to_contain_text('word1799')
        expect(page.locator('#sync-status')).to_have_text('Saved to storage', timeout=15000)
        expect(paper).to_have_attribute('data-pages', re.compile('[3-9]|[1-9][0-9]+'))
        assert paper.evaluate("el => [...el.querySelectorAll('.doc-page-gap')].every(g => g.getBoundingClientRect().height > 0)")
        # Decorations must not become document content, including on export.
        paper.click(position={'x': 100, 'y': 100})
        page.keyboard.press('Control+Home')
        page.keyboard.type('Edited ')
        expect(paper).to_contain_text('Edited word0')
        page.get_by_role('button', name='Save now', exact=True).click()
        expect(page.locator('#sync-status')).to_have_text(re.compile('^(Saved|Synced) to storage$'), timeout=15000)
        from docx import Document
        import io
        exported = Document(io.BytesIO(page.request.get(realtime_server + f'/documents/{doc.pk}/export/').body()))
        assert '\n'.join(x.text for x in exported.paragraphs) == 'Edited ' + text
        viewer = browser.new_page(viewport={'width': 1440, 'height': 1000})
        login(viewer, realtime_server, 'admin')
        viewer.goto(realtime_server + f'/documents/{doc.pk}/')
        preview = viewer.locator('.paged-document')
        expect(preview).to_be_visible()
        expect(preview).to_have_attribute('data-pages', re.compile('[3-9]|[1-9][0-9]+'))
        assert preview.evaluate("el => el.textContent.replace(/Page [0-9]+/g, '').trim()") == 'Edited ' + text
        for document in [paper, preview]:
            boundaries = document.evaluate("el => [...el.querySelectorAll('.doc-page-gap')].map(g => g.getBoundingClientRect().top + parseFloat(g.style.getPropertyValue('--page-band')))")
            assert all(1080 < b-a < 1180 for a, b in zip(boundaries, boundaries[1:])), boundaries
        viewer.screenshot(path='/tmp/yourwiki-document-pages.png', full_page=True)
        paper.click(position={'x': 100, 'y': 100})
        page.keyboard.press('Control+a')
        page.keyboard.type('Short document')
        expect(paper).to_have_attribute('data-pages', '1')
        expect(paper.locator('.doc-page-gap')).to_have_count(0)
        page.set_viewport_size({'width': 390, 'height': 844})
        page.reload()
        expect(page.get_by_label('Zoom', exact=True)).to_have_value('fit')
        expect(paper).to_be_visible()
        assert paper.bounding_box()['width'] < 390
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not errors
        browser.close()
