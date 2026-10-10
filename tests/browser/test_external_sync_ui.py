import io
import os
import pytest
from playwright.sync_api import expect, sync_playwright
from wiki.services import save_document
from wiki.storage import active_storage
from tests.browser.test_word_editor import login
from tests.test_pdf_ai import sample_pdf

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_remote_edit_updates_open_document_and_pdf(realtime_server, workspace, monkeypatch, tmp_path):
    monkeypatch.setattr('wiki.external_sync.INTERVAL', 1)
    doc = save_document(workspace['admin'], 'Remote document', 'document', 'Notes',
                        'Initial original', workspace['team'], file_format='md')
    pdf = save_document(workspace['admin'], 'Remote.pdf', 'file', 'Notes', sample_pdf(), workspace['team'])
    adapter = active_storage()
    paths = [workspace['root'] / adapter.reference(item.reference)[1] for item in [doc, pdf]]
    from pypdf import PdfReader, PdfWriter
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(sample_pdf())))
    writer.update_page_form_field_values(writer.pages[0], {'customer':'Remote customer'}, auto_regenerate=False)
    output = io.BytesIO(); writer.write(output)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width':1440,'height':900})
        # Accelerate the real heartbeat without exposing a production force API.
        page.add_init_script('const interval=window.setInterval;window.setInterval=(fn,ms,...args)=>interval(fn,ms===30000?1000:ms,...args)')
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        login(page,realtime_server,'admin')
        page.goto(realtime_server+f'/documents/{doc.pk}/live/')
        expect(page.locator('#sync-status')).to_have_text('Saved to storage',timeout=15000)
        paths[0].write_text('Updated externally',encoding='utf-8')
        expect(page.locator('.tiptap')).to_contain_text('Updated externally',timeout=15000)
        expect(page.locator('.tiptap')).not_to_contain_text('Initial original')
        page.goto(realtime_server+f'/documents/{pdf.pk}/')
        expect(page.locator('.annotationLayer input[name="customer"]')).to_have_value('Original customer',timeout=15000)
        page.evaluate('window.syncMarker="same page"')
        paths[1].write_bytes(output.getvalue())
        expect(page.locator('.annotationLayer input[name="customer"]')).to_have_value('Remote customer',timeout=15000)
        assert page.evaluate('window.syncMarker')=='same page'
        assert page.locator('#pdf-container').bounding_box()['height']>720
        page.screenshot(path='/tmp/yourwiki-pdf-expanded.png')
        page.route('**/documents/*/pdf/',lambda route:route.fulfill(status=503,content_type='application/json',body='{}'))
        field=page.locator('.annotationLayer input[name="customer"]')
        field.fill('Local customer')
        paths[1].write_bytes(sample_pdf())
        expect(page.locator('#pdf-status')).to_contain_text('The original changed',timeout=15000)
        expect(field).to_have_value('Local customer')
        page.locator('.pdf-more > summary').click()
        with page.expect_download() as download:
            page.locator('#pdf-download').click()
        recovered=tmp_path/'local-edits.pdf';download.value.save_as(recovered)
        assert PdfReader(recovered).get_fields()['customer']['/V']=='Local customer'
        assert PdfReader(paths[1]).get_fields()['customer']['/V']=='Original customer'
        assert not errors
        page.on('dialog',lambda dialog:dialog.accept())
        browser.close()
