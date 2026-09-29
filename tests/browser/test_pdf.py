import os
from io import BytesIO

import pytest
from playwright.sync_api import sync_playwright, expect
from pypdf import PdfReader
from reportlab.pdfgen.canvas import Canvas

from wiki.models import Document
from wiki.services import save_document
from wiki.storage import active_storage

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_pdf_annotations_and_forms(realtime_server, workspace):
    stream = BytesIO(); canvas = Canvas(stream, pagesize=(600, 800))
    canvas.drawString(40, 740, 'Original page layout')
    canvas.acroForm.textfield(name='customer', x=40, y=640, width=220, height=30, value='Original')
    canvas.showPage(); canvas.save()
    doc = save_document(workspace['admin'], 'form.pdf', 'file', 'PDFs', stream.getvalue(), workspace['team'])
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1400, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(realtime_server + '/login/')
        page.get_by_label('Username').fill('admin')
        page.get_by_label('Password', exact=True).fill('Correct-password-8923')
        page.get_by_role('button', name='Sign in', exact=True).click()
        url = realtime_server + f'/documents/{doc.pk}/'
        page.goto(url)
        expect(page.locator('#pdf-status')).to_have_text('PDF ready', timeout=15000)
        field = page.locator('.annotationLayer input[name="customer"]')
        expect(field).to_have_value('Original', timeout=15000)
        field.fill('Filled in browser')
        page.locator('#pdf-tool').select_option('3')
        layer = page.locator('.annotationEditorLayer').first
        expect(layer).to_be_visible()
        layer.click(position={'x': 320, 'y': 280})
        annotation = page.locator('.freeTextEditor [contenteditable="true"]').first
        expect(annotation).to_be_visible()
        annotation.fill('Browser annotation')
        page.get_by_role('button', name='Save PDF', exact=True).click()
        expect(page.locator('#pdf-status')).to_have_text('PDF saved', timeout=15000)
        reader = PdfReader(BytesIO(page.request.get(url + 'export/').body()))
        assert reader.get_fields()['customer']['/V'] == 'Filled in browser'
        assert 'Original page layout' in reader.pages[0].extract_text()
        assert any('Browser annotation' in str(ref.get_object().get('/Contents', '')) for ref in reader.pages[0]['/Annots'])
        page.reload()
        expect(page.locator('.annotationLayer input[name="customer"]')).to_have_value('Filled in browser', timeout=15000)
        from pathlib import Path
        Path('test-results').mkdir(exist_ok=True)
        page.evaluate('window.scrollTo(0, 0)')
        assert page.locator('.sidebar').evaluate('(el) => getComputedStyle(el).position') == 'fixed'
        page.screenshot(path='test-results/pdf.png', full_page=True)
        assert not errors
        browser.close()

    doc.refresh_from_db()
    assert doc.revision == 2


def test_table_controls_and_simplified_pages(realtime_server, workspace):
    doc = save_document(workspace['admin'], 'Table', 'table', 'Tables', '1,2\n3,4', workspace['team'])
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.add_init_script("localStorage.setItem('yourwiki-theme', 'dark')")
        page.goto(realtime_server + '/login/')
        page.get_by_label('Username').fill('admin')
        page.get_by_label('Password', exact=True).fill('Correct-password-8923')
        page.get_by_role('button', name='Sign in', exact=True).click()
        page.goto(realtime_server + f'/documents/{doc.pk}/')
        expect(page.get_by_role('link', name='Edit document', exact=True)).to_have_count(0)
        page.get_by_role('link', name='Open visual editor', exact=True).click()
        expect(page.locator('.sheet-host canvas').first).to_be_visible(timeout=20000)
        expect(page.locator('#sync-status')).to_contain_text('Synced', timeout=15000)
        inputs = page.locator('.sheet-host input')
        assert inputs.count() > 0
        assert inputs.evaluate_all("els => els.every(el => getComputedStyle(el).minHeight !== '44px')")
        assert page.locator('.sheet-host').evaluate('el => getComputedStyle(el).colorScheme') == 'light'
        from pathlib import Path
        Path('test-results').mkdir(exist_ok=True)
        page.screenshot(path='test-results/table-dark.png', full_page=True)
        page.goto(realtime_server + '/account/')
        expect(page.locator('main [data-theme-toggle]')).to_have_count(0)
        browser.close()
