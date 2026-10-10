import os
import pytest
from playwright.sync_api import sync_playwright, expect
from wiki.services import save_document

pytestmark=[pytest.mark.browser,pytest.mark.django_db(transaction=True),pytest.mark.skipif(os.environ.get('RUN_BROWSER')!='1',reason='Set RUN_BROWSER=1')]

def test_autosave_and_conflict_copy(realtime_server,workspace):
    doc=save_document(workspace['admin'],'Autosave','document','Notes','Original paragraph',workspace['team'],file_format='md')
    from wiki.storage import active_storage
    mount,ref=active_storage().reference(doc.reference)
    path=workspace['root']/ref
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page=browser.new_page(viewport={'width':1440,'height':1000})
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(realtime_server+'/login/');page.get_by_label('Username').fill('admin');page.get_by_label('Password',exact=True).fill('Correct-password-8923');page.get_by_role('button',name='Sign in',exact=True).click()
        page.goto(realtime_server+f'/documents/{doc.pk}/live/')
        editor=page.locator('.document-host .tiptap');expect(editor).to_contain_text('Original paragraph')
        editor.click();page.keyboard.press('Control+End');page.keyboard.type(' Automatically saved')
        expect(page.locator('#sync-status')).to_have_text('Saved to storage',timeout=15000)
        assert 'Automatically saved' in path.read_text()
        path.write_text('Changed outside Yourwiki')
        editor.click();page.keyboard.press('Control+End');page.keyboard.type(' Keep my local changes')
        expect(page.locator('#save-conflict')).to_be_visible(timeout=15000)
        expect(page.locator('#save-live')).to_be_disabled()
        expect(editor).to_contain_text('Keep my local changes')
        assert path.read_text()=='Changed outside Yourwiki'
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
        page.locator('#conflict-save-copy').click()
        page.locator('#dialog-fields input[name="title"]').fill('Recovered browser copy')
        page.get_by_role('button',name='Apply',exact=True).click()
        page.wait_for_url(lambda url:str(doc.pk) not in url and '/live/' in url)
        expect(page.locator('.document-host .tiptap')).to_contain_text('Keep my local changes')
        assert path.read_text()=='Changed outside Yourwiki'
        assert not errors,errors
        browser.close()

def test_pdf_download_keeps_edits_after_write_revocation(realtime_server,workspace,tmp_path):
    from tests.test_pdf_ai import sample_pdf
    from pypdf import PdfReader
    doc=save_document(workspace['admin'],'Recovery.pdf','file','Files',sample_pdf(),workspace['team'])
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page=browser.new_page()
        page.goto(realtime_server+'/login/');page.get_by_label('Username').fill('admin');page.get_by_label('Password',exact=True).fill('Correct-password-8923');page.get_by_role('button',name='Sign in',exact=True).click()
        page.route('**/documents/*/pdf/',lambda route:route.fulfill(status=403,content_type='application/json',body='{"error":"Access denied"}'))
        page.goto(realtime_server+f'/documents/{doc.pk}/')
        field=page.locator('.annotationLayer input[name="customer"]')
        expect(field).to_have_value('Original customer',timeout=15000)
        field.fill('Retain my pending PDF changes')
        expect(page.locator('#pdf-status')).to_contain_text('Write access was revoked',timeout=15000)
        page.locator('.pdf-more > summary').click()
        with page.expect_download() as download:
            page.locator('#pdf-download').click()
        path=tmp_path/'recovered.pdf';download.value.save_as(path)
        assert PdfReader(path).get_fields()['customer']['/V']=='Retain my pending PDF changes'
        page.on('dialog',lambda dialog:dialog.accept())
        browser.close()
