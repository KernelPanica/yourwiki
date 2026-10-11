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


@pytest.mark.parametrize('kind', ['document', 'pdf'])
def test_leaving_dirty_editor_does_not_force_save(realtime_server, workspace, kind):
    """Lifecycle events warn without issuing HTTP flushes or WebSocket saves."""
    doc = save_document(workspace['admin'], 'Exit.pdf' if kind == 'pdf' else 'Exit document',
                        'file' if kind == 'pdf' else 'document', 'Notes',
                        sample_pdf() if kind == 'pdf' else 'Initial text', workspace['team'])
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page()
        login(page, realtime_server, 'admin')
        page.goto(realtime_server + f'/documents/{doc.pk}/' + ('live/' if kind == 'document' else ''))
        if kind == 'document':
            expect(page.locator('#sync-status')).to_have_text('Saved to storage', timeout=15000)
        else:
            expect(page.locator('.annotationLayer input[name="customer"]')).to_have_value('Original customer', timeout=15000)
        page.evaluate('''() => {
            window.exitWrites = [];
            const timeout = window.setTimeout;
            // Isolate navigation from the ordinary edit-triggered autosave timer.
            window.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 1500 ? 60000 : ms, ...args);
            const fetch = window.fetch;
            window.fetch = (url, options) => {
                if (options?.method === 'POST' && /\\/(flush|pdf)\\//.test(String(url))) window.exitWrites.push(String(url));
                return fetch(url, options);
            };
            const send = WebSocket.prototype.send;
            WebSocket.prototype.send = function(data) {
                if (JSON.parse(data).type === 'save') window.exitWrites.push('websocket save');
                return send.call(this, data);
            };
        }''')
        if kind == 'document':
            page.locator('.tiptap').fill('Unsaved exit edits')
        else:
            page.locator('.annotationLayer input[name="customer"]').fill('Unsaved exit edits')
        assert page.evaluate('''() => {
            const event = new Event('beforeunload', {cancelable:true});
            window.dispatchEvent(event);
            window.dispatchEvent(new Event('pagehide'));
            Object.defineProperty(document, 'hidden', {configurable:true, value:true});
            document.dispatchEvent(new Event('visibilitychange'));
            return event.defaultPrevented;
        }''')
        page.wait_for_timeout(500)
        assert page.evaluate('window.exitWrites') == []
        page.on('dialog', lambda dialog: dialog.accept())
        browser.close()


def test_remote_conflict_warns_and_copies_local_edits(realtime_server, workspace, monkeypatch):
    monkeypatch.setattr('wiki.external_sync.INTERVAL', 1)
    doc = save_document(workspace['admin'], 'Conflicting original', 'document', 'Notes',
                        'Initial original', workspace['team'], file_format='md')
    adapter = active_storage()
    path = workspace['root'] / adapter.reference(doc.reference)[1]
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width':1440,'height':900})
        page.add_init_script('Object.defineProperty(navigator,"clipboard",{value:{writeText:async text=>{window.copiedEdits=text;}}})')
        login(page, realtime_server, 'admin')
        page.goto(realtime_server + f'/documents/{doc.pk}/live/')
        expect(page.locator('#sync-status')).to_have_text('Saved to storage', timeout=15000)
        page.locator('.tiptap').fill('My local edits')
        path.write_text('Remote original edits', encoding='utf-8')
        banner = page.locator('#save-conflict')
        expect(banner).to_be_visible(timeout=15000)
        expect(banner).to_have_class('settings-card source-conflict-banner')
        expect(banner).to_contain_text('Your changes will not be saved')
        expect(page.locator('#save-live')).to_be_disabled()
        page.locator('#conflict-copy').click()
        expect(page.locator('#conflict-copy-status')).to_have_text('Copied')
        assert page.evaluate('window.copiedEdits') == 'My local edits'
        page.locator('.tiptap').fill('Further local edits')
        expect(page.locator('#sync-status')).to_have_text('Conflict · automatic saving paused')
        expect(page.locator('#conflict-copy-status')).to_be_empty()
        page.screenshot(path='/tmp/yourwiki-source-conflict.png')
        page.wait_for_timeout(1700)
        assert path.read_text() == 'Remote original edits'
        page.on('dialog', lambda dialog:dialog.accept())
        browser.close()


def test_office_remote_conflict_never_reloads_unsignalled_edits(realtime_server, workspace, settings, monkeypatch):
    from tests.test_collabora import rich_docx
    settings.COLLABORA_URL = realtime_server
    settings.COLLABORA_WOPI_URL = realtime_server
    monkeypatch.setattr('wiki.collabora.editor_action', lambda *args:realtime_server+'/mock-office/')
    doc = save_document(workspace['admin'], 'Office conflict', 'document', 'Notes',
                        'Initial original', workspace['team'])
    adapter = active_storage()
    path = workspace['root'] / adapter.reference(doc.reference)[1]
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page()
        page.add_init_script('const interval=window.setInterval;window.setInterval=(fn,ms,...args)=>interval(fn,ms===30000?1000:ms,...args)')
        page.route('**/mock-office/**', lambda route:route.fulfill(status=200, content_type='text/html', body='<p>Office editing buffer</p>'))
        login(page, realtime_server, 'admin')
        page.goto(realtime_server+f'/documents/{doc.pk}/office/')
        expect(page.locator('#office-frame')).to_be_visible()
        page.evaluate('window.noReloadMarker="edits in this frame"')
        external = rich_docx()
        path.write_bytes(external)
        banner = page.locator('#office-conflict')
        expect(banner).to_be_visible(timeout=15000)
        expect(banner).to_contain_text('Your changes will not be saved')
        assert page.evaluate('window.noReloadMarker') == 'edits in this frame'
        assert path.read_bytes() == external
        expect(page.locator('#office-download-current')).to_be_visible()
        page.on('dialog', lambda dialog:dialog.accept())
        browser.close()


@pytest.fixture
def discovery_server(monkeypatch, request):
    monkeypatch.setattr('wiki.discovery.INTERVAL',1)
    return request.getfixturevalue('realtime_server')


def test_new_remote_files_are_discovered_without_manual_command(discovery_server, workspace):
    import time
    from wiki.models import Document,Folder
    root=workspace['root']
    (root/'Remote files').mkdir();(root/'Empty remote').mkdir()
    (root/'Remote files'/'External upload.bin').write_bytes(b'from the source')
    deadline=time.monotonic()+15
    while time.monotonic()<deadline and not Document.objects.filter(title='External upload.bin').exists():
        time.sleep(.1)
    doc=Document.objects.get(title='External upload.bin')
    assert doc.folder.name=='Remote files' and doc.inherit_permissions
    assert Folder.objects.filter(name='Empty remote').exists()
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page=browser.new_page();login(page,discovery_server,'admin')
        page.goto(discovery_server+f'/folders/{doc.folder_id}/')
        expect(page.locator('#main-content').get_by_role('link',name='External upload.bin',exact=True)).to_be_visible()
        browser.close()
    time.sleep(1.2)
    assert Document.objects.filter(title='External upload.bin').count()==1
    assert (root/'Remote files'/'External upload.bin').read_bytes()==b'from the source'
