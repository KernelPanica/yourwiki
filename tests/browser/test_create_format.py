"""Changing a creation type preserves the form and updates the actual file name."""
import os
import pytest
from playwright.sync_api import expect, sync_playwright
from wiki.models import Document
from wiki.storage import active_storage

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_creation_format_changes_without_navigation(realtime_server, workspace):
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width':320,'height':900})
        page.goto(realtime_server + '/login/')
        page.get_by_label('Username').fill('admin')
        page.get_by_label('Password', exact=True).fill('Correct-password-8923')
        page.get_by_role('button', name='Sign in', exact=True).click()
        page.goto(realtime_server + '/documents/new/')
        page.evaluate('window.creationMarker = "same-page"')
        page.locator('#id_title').fill('Report.docx')
        page.locator('#id_content').evaluate('e => e.value = "Keep this text"')
        expect(page.locator('#file-name-preview')).to_have_text('Report.docx')
        page.locator('#id_file_format').select_option('md')
        expect(page.locator('#file-name-preview')).to_have_text('Report.md')
        for kind, name in [('table','Report.ods'), ('drawio','Report.drawio'),
                           ('canvas','Report.canvas'), ('file','Report.docx')]:
            page.locator(f'[data-create-kind="{kind}"]').click()
            expect(page.locator('#file-name-preview')).to_have_text(name)
            expect(page.locator('#id_file_format')).to_be_disabled()
            expect(page.locator('#id_content')).to_have_value('Keep this text')
            expect(page.locator('#id_title')).to_have_value('Report.docx')
            assert page.evaluate('window.creationMarker') == 'same-page'
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.locator('[data-create-kind="document"]').click()
        expect(page.locator('#id_file_format')).to_have_value('md')
        expect(page.locator('#id_file_format')).to_be_enabled()
        expect(page.locator('#file-name-preview')).to_have_text('Report.md')
        page.locator('[data-create-file]').click()
        expect(page.locator('.tiptap')).to_contain_text('Keep this text')
        browser.close()
    doc = Document.objects.get(title='Report')
    assert doc.file_format == 'md'
    assert active_storage().location(doc.reference).endswith('Report.md')
