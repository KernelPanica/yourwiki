"""Desktop/mobile sidebar and vertical panes, without requiring a CODE server."""
import os
from io import BytesIO
from unittest.mock import patch
import pytest
from playwright.sync_api import expect, sync_playwright
from reportlab.pdfgen import canvas
from wiki.services import save_document
from tests.browser.test_word_editor import login

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


@pytest.mark.parametrize('width', [1440, 390])
def test_sidebar_and_resizable_office_pdf(realtime_server, workspace, settings, width):
    office = save_document(workspace['admin'], 'Resize office', 'document', 'Notes', 'Text', workspace['team'])
    output = BytesIO(); pdf = canvas.Canvas(output); pdf.drawString(60, 700, 'Resize PDF'); pdf.save()
    doc = save_document(workspace['admin'], 'Resize.pdf', 'file', 'Notes', output.getvalue(), workspace['team'])
    settings.COLLABORA_URL = realtime_server
    settings.COLLABORA_WOPI_URL = realtime_server
    with patch('wiki.collabora.editor_action', return_value=realtime_server + '/health/'), sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width':width, 'height':1000}, is_mobile=width < 800, has_touch=width < 800)
        errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
        login(page, realtime_server, 'admin')
        expect(page.locator('.sidebar-create')).to_have_count(0)
        creation = page.locator('.heading-actions .create-menu')
        creation.locator('summary').click()
        expect(creation.get_by_role('link', name='Folder', exact=True)).to_be_visible()
        expect(creation.get_by_role('link', name='File', exact=True)).to_be_visible()
        assert '/new' in creation.get_by_role('link', name='File', exact=True).get_attribute('href')
        box = creation.locator('.create-menu-panel').bounding_box()
        assert box['x'] >= 0 and box['x'] + box['width'] <= width
        creation.locator('summary').click()
        expect(creation).not_to_have_attribute('open', '')
        toggle = page.locator('[data-sidebar-open]')
        expect(toggle).to_be_visible()
        if width > 800:
            expect(toggle).to_have_attribute('aria-expanded', 'true')
            toggle.click()
            expect(toggle).to_have_attribute('aria-expanded', 'false')
            page.goto(realtime_server + '/account/')
            expect(toggle).to_have_attribute('aria-expanded', 'false')
        toggle.click()
        expect(toggle).to_have_attribute('aria-expanded', 'true')
        expect(page.locator('#workspace-sidebar')).to_have_attribute('aria-hidden', 'false')
        creation = page.locator('.explorer-actions .create-menu')
        creation.locator('summary').click()
        expect(creation.get_by_role('link', name='Folder', exact=True)).to_be_visible()
        expect(creation.get_by_role('link', name='File', exact=True)).to_be_visible()
        box = creation.locator('.create-menu-panel').bounding_box()
        assert box['x'] >= 0 and box['x'] + box['width'] <= width
        creation.get_by_role('link', name='File', exact=True).click()
        expect(page.locator('[data-create-file]')).to_be_visible()
        if width < 800:
            toggle.click()
        page.locator('[data-sidebar-open]').click()
        expect(toggle).to_have_attribute('aria-expanded', 'false')
        for url, kind in [(f'/documents/{office.pk}/office/', 'office'), (f'/documents/{doc.pk}/', 'pdf')]:
            page.goto(realtime_server + url)
            if kind == 'pdf':
                expect(page.locator('#pdf-status')).to_have_text('PDF ready', timeout=15000)
            pane = page.locator(f'[data-workspace-resize="{kind}"]')
            grip = pane.get_by_role('separator')
            expect(grip).to_be_visible()
            initial = pane.bounding_box()['height']
            grip.focus()
            for _ in range(5): page.keyboard.press('ArrowUp')
            reduced = pane.bounding_box()['height']
            assert reduced < initial - 100
            box = grip.bounding_box(); x, y = box['x'] + box['width']/2, box['y'] + box['height']/2
            page.mouse.move(x,y); page.mouse.down(); page.mouse.move(x,y-60,steps=6); page.mouse.up()
            dragged = pane.bounding_box()['height']
            assert abs(dragged - max(260, reduced-60)) < 3
            box = grip.bounding_box(); x, y = box['x'] + box['width']/2, box['y'] + box['height']/2
            page.mouse.move(x,y); page.mouse.down(); page.mouse.move(x,y+60,steps=6); page.mouse.up()
            expanded = pane.bounding_box()['height']
            assert abs(expanded - dragged - 60) < 3
            dragged = expanded
            page.reload()
            if kind == 'pdf':
                expect(page.locator('#pdf-status')).to_have_text('PDF ready', timeout=15000)
                expect(page.locator('#pdf-container .page').first).to_be_visible()
            expect(grip).to_be_visible()
            assert abs(pane.bounding_box()['height'] - dragged) < 3
            grip.dblclick()
            assert abs(pane.bounding_box()['height'] - initial) < 8
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=f'/tmp/yourwiki-{kind}-resize-{width}.png')
        assert not errors, errors
        browser.close()


@pytest.mark.parametrize('width', [1440, 390])
def test_presentation_has_more_vertical_space(realtime_server, workspace, settings, width):
    doc = save_document(workspace['admin'], 'Tall slides', 'presentation', 'Notes', 'Slides', workspace['team'])
    settings.COLLABORA_URL = settings.COLLABORA_WOPI_URL = realtime_server
    with patch('wiki.collabora.editor_action', return_value=realtime_server + '/health/'), sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width':width,'height':900})
        login(page, realtime_server, 'admin')
        page.goto(realtime_server + f'/documents/{doc.pk}/office/')
        pane = page.locator('[data-workspace-resize="presentation"]')
        grip = pane.get_by_role('separator')
        box = pane.bounding_box()
        initial = box['height']
        assert abs(initial - max(260, 900-box['y']-12+160)) < 3
        grip.focus(); page.keyboard.press('End')
        expect(grip).to_have_attribute('aria-valuemax', '5400')
        assert abs(pane.bounding_box()['height'] - 5400) < 3
        page.reload()
        assert abs(pane.bounding_box()['height'] - 5400) < 3
        grip.dblclick()
        assert abs(pane.bounding_box()['height'] - initial) < 3
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        browser.close()


@pytest.mark.parametrize('dirty', [False, True])
def test_office_external_update_reload_or_preserve_edits(realtime_server, workspace, settings, dirty):
    from wiki.storage import active_storage
    from tests.test_collabora import rich_docx
    doc = save_document(workspace['admin'], 'External office', 'document', 'Notes', 'Text', workspace['team'])
    path = workspace['root'] / active_storage().location(doc.reference)
    settings.COLLABORA_URL = settings.COLLABORA_WOPI_URL = realtime_server
    with patch('wiki.collabora.editor_action', return_value=realtime_server + '/health/'), sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page()
        page.route('**/health/**', lambda route: route.fulfill(content_type='text/html', body='<html><body>Office test frame</body></html>'))
        page.add_init_script('const interval=window.setInterval;window.setInterval=(fn,ms,...args)=>interval(fn,ms===30000?500:ms,...args)')
        login(page, realtime_server, 'admin')
        page.goto(realtime_server + f'/documents/{doc.pk}/office/')
        page.wait_for_function('() => document.getElementById("office-frame").contentDocument?.readyState === "complete"')
        office_frame = next(f for f in page.frames if f.name == 'office-frame')
        office_frame.evaluate("dirty => parent.postMessage({MessageId:'Doc_ModifiedStatus',Values:{Modified:dirty}},location.origin)", dirty)
        page.evaluate('window.oldSession=JSON.parse(document.getElementById("office-bootstrap").textContent).session')
        session = page.evaluate('window.oldSession')
        path.write_bytes(rich_docx())
        if dirty:
            expect(page.locator('#office-conflict')).to_be_visible(timeout=10000)
            assert page.evaluate('JSON.parse(document.getElementById("office-bootstrap").textContent).session') == session
            assert 'Copy' in page.locator('#office-conflict').inner_text() or 'copy' in page.locator('#office-conflict').inner_text()
            page.evaluate('window.warned=false;window.addEventListener("beforeunload",e=>window.warned=e.defaultPrevented);window.dispatchEvent(new Event("beforeunload",{cancelable:true}))')
            assert page.evaluate('window.warned')
        else:
            # A writable office session can contain pending edits before the
            # modified notification arrives; preserve it and warn explicitly.
            expect(page.locator('#office-conflict')).to_be_visible(timeout=10000)
            assert page.evaluate('JSON.parse(document.getElementById("office-bootstrap").textContent).session') == session
        browser.close()
