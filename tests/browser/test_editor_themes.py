"""Editor surfaces retain contrast and graph connections in both site themes."""
import json
import os

import pytest
from playwright.sync_api import expect, sync_playwright

from tests.browser.test_word_editor import login
from wiki.services import save_document

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def contrast(locator):
    return locator.evaluate("""el => {
        const style = getComputedStyle(el);
        const luminance = color => {
            const rgb = color.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => {
                v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
            });
            return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
        };
        const a = luminance(style.color), b = luminance(style.backgroundColor);
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    }""")


@pytest.mark.parametrize('kind', ['canvas', 'table', 'document'])
def test_editor_dark_theme_surfaces(realtime_server, workspace, kind):
    canvas = {'nodes': [
        {'id': 'group', 'type': 'group', 'label': 'Group', 'color': '5', 'x': -40, 'y': -40, 'width': 650, 'height': 450},
        {'id': 'a', 'type': 'text', 'text': 'Source', 'x': 0, 'y': 0, 'width': 180, 'height': 100},
        {'id': 'b', 'type': 'text', 'text': 'Destination', 'x': 320, 'y': 220, 'width': 180, 'height': 100}],
        'edges': [{'id': 'ab', 'fromNode': 'a', 'toNode': 'b', 'fromSide': 'right', 'toSide': 'left', 'toEnd': 'arrow', 'label': 'Connection'}]}
    content = json.dumps(canvas) if kind == 'canvas' else 'Visible content'
    doc = save_document(workspace['admin'], 'Theme ' + kind, kind, 'Notes', content, workspace['team'])
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        login(page, realtime_server, 'admin')
        # Public and authenticated pages advertise usable icons.
        assert 'wiki/favicon.svg' in page.request.get(realtime_server + '/login/').text()
        for icon in page.locator('link[rel="icon"]').evaluate_all('els => els.map(el => el.href)'):
            assert page.request.get(icon).status == 200
        page.evaluate("localStorage.setItem('yourwiki-theme','dark')")
        page.goto(realtime_server + f'/documents/{doc.pk}/live/')
        expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        if kind == 'canvas':
            expect(page.locator('[data-node-id="a"]')).to_be_visible()
            page.get_by_role('button', name='Edit selected', exact=True).click()
            expect(page.locator('#editor-error')).to_be_visible()
            page.screenshot(path='/tmp/yourwiki-theme-canvas-dark.png')
            assert contrast(page.locator('#editor-error')) >= 4.5
            # Connections must sit above opaque group cards, below ordinary cards.
            layers = page.evaluate("""() => {
                const layer = selector => Number(getComputedStyle(document.querySelector(selector)).zIndex) || 0;
                return [layer('.canvas-node[data-type=group]'), layer('.canvas-edges'), layer('.canvas-node[data-type=text]')];
            }""")
            assert layers[0] < layers[1] < layers[2], layers
            assert contrast(page.locator('[data-node-id="group"]')) >= 4.5
            page.get_by_role('button', name='Add text', exact=True).click()
            expect(page.locator('#editor-dialog')).to_be_visible()
            assert contrast(page.locator('#editor-dialog')) >= 4.5
            assert contrast(page.locator('#dialog-fields textarea')) >= 4.5
            page.locator('#editor-dialog button[value="cancel"]').click()
        elif kind == 'table':
            expect(page.locator('.sheet-host canvas[id^="univer-sheet-main-canvas"]')).to_be_visible(timeout=30000)
            page.screenshot(path='/tmp/yourwiki-theme-table-dark.png')
            assert contrast(page.get_by_label('Cell or range address', exact=True)) >= 4.5
            assert contrast(page.get_by_label('Value or formula', exact=True)) >= 4.5
            page.locator('.sheet-function-panel summary').click()
            assert contrast(page.get_by_label('Search functions', exact=True)) >= 4.5
        else:
            expect(page.locator('.tiptap')).to_contain_text('Visible content')
            page.screenshot(path='/tmp/yourwiki-theme-document-dark.png')
            assert contrast(page.locator('.tiptap')) >= 4.5
        assert page.locator('link[rel="icon"][type="image/svg+xml"]').count() == 1
        page.locator('[data-theme-toggle]').evaluate('el => el.click()')
        expect(page.locator('html')).to_have_attribute('data-theme', 'light')
        if kind == 'canvas':
            assert contrast(page.locator('#editor-error')) >= 4.5
            assert contrast(page.locator('[data-node-id="group"]')) >= 4.5
        elif kind == 'table':
            assert contrast(page.get_by_label('Cell or range address', exact=True)) >= 4.5
            assert contrast(page.get_by_label('Value or formula', exact=True)) >= 4.5
        page.screenshot(path=f'/tmp/yourwiki-theme-{kind}-light.png')
        if kind == 'canvas':
            page.goto(realtime_server + f'/documents/{doc.pk}/')
            expect(page.locator('.graph')).to_be_visible()
            # SVG paints later elements on top: groups, then links, then cards.
            order = page.locator('.graph').evaluate("""el => {
                const children = [...el.children];
                return [children.indexOf(el.querySelector('[data-node-id=group]')),
                        children.indexOf(el.querySelector(':scope > path')),
                        children.indexOf(el.querySelector('[data-node-id=a]'))];
            }""")
            assert order[0] < order[1] < order[2], order
            page.screenshot(path='/tmp/yourwiki-theme-canvas-preview-light.png')
        assert not errors, errors
        browser.close()


@pytest.mark.parametrize('kind', ['pdf', 'drawio'])
def test_embedded_editor_dark_theme(realtime_server, workspace, kind):
    if kind == 'pdf':
        from io import BytesIO
        from reportlab.pdfgen.canvas import Canvas
        stream = BytesIO()
        canvas = Canvas(stream)
        canvas.drawString(40, 700, 'Readable PDF')
        canvas.showPage()
        canvas.save()
        doc = save_document(workspace['admin'], 'Theme.pdf', 'file', 'Notes', stream.getvalue(), workspace['team'])
    else:
        xml = '<mxfile><diagram id="p" name="Page"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="n" vertex="1" parent="1" value="Readable diagram"><mxGeometry x="10" y="10" width="200" height="100" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>'
        doc = save_document(workspace['admin'], 'Theme diagram', 'drawio', 'Notes', xml, workspace['team'])
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        login(page, realtime_server, 'admin')
        page.evaluate("localStorage.setItem('yourwiki-theme','dark')")
        page.goto(realtime_server + f'/documents/{doc.pk}/' + ('live/' if kind == 'drawio' else ''))
        if kind == 'pdf':
            expect(page.locator('#pdf-status')).to_have_text('PDF ready', timeout=20000)
            for selector in ['#pdf-page', '#pdf-zoom', '#pdf-tool']:
                assert contrast(page.locator(selector)) >= 4.5
            page.locator('#pdf-controls .pdf-more summary').click()
            assert contrast(page.locator('#pdf-text-size')) >= 4.5
        else:
            expect(page.frame_locator('.drawio-frame').locator('.geDiagramContainer')).to_contain_text('Readable diagram', timeout=45000)
            page.evaluate("window.yourwikiUI.run(()=>{throw new window.yourwikiUI.UIError('Cannot edit this file.')},document.getElementById('editor-error'))")
            expect(page.locator('#editor-error')).to_contain_text('Cannot edit this file.')
            assert contrast(page.locator('#editor-error')) >= 4.5
        page.screenshot(path=f'/tmp/yourwiki-theme-{kind}-dark.png')
        assert not errors, errors
        browser.close()
