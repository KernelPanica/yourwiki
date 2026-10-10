import os
from io import BytesIO

import pytest
from playwright.sync_api import expect, sync_playwright
from reportlab.pdfgen.canvas import Canvas

from wiki.services import save_document

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_pdf_viewport_zoom_pan_and_explorer(realtime_server, workspace):
    stream = BytesIO()
    canvas = Canvas(stream, pagesize=(600, 800))
    canvas.drawString(40, 740, 'PDF workspace navigation')
    canvas.showPage()
    canvas.save()
    doc = save_document(workspace['admin'], 'navigation.pdf', 'file', 'PDFs', stream.getvalue(), workspace['team'])
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width': 1200, 'height': 900})
        page.goto(realtime_server + '/login/')
        page.get_by_label('Username').fill('admin')
        page.get_by_label('Password', exact=True).fill('Correct-password-8923')
        page.get_by_role('button', name='Sign in', exact=True).click()
        page.goto(realtime_server + f'/documents/{doc.pk}/')
        expect(page.locator('#pdf-status')).to_have_text('PDF ready', timeout=15000)
        container = page.locator('#pdf-container')
        bounds = container.bounding_box()
        assert bounds['height'] > 650
        assert bounds['y'] + bounds['height'] <= 900
        page.get_by_role('button', name='Open file explorer', exact=True).click()
        expect(page.locator('#workspace-sidebar')).to_have_attribute('aria-hidden', 'false')
        page.locator('#workspace-sidebar [data-sidebar-close]').click()
        expect(page.locator('#workspace-sidebar')).to_have_attribute('aria-hidden', 'true')
        page.locator('#pdf-zoom').select_option('2')
        page.wait_for_function('document.getElementById("pdf-container").scrollWidth > document.getElementById("pdf-container").clientWidth')
        page.locator('#pdf-zoom-out').click()
        expect(page.locator('#pdf-zoom')).to_have_value('1.75')
        page.locator('#pdf-zoom-in').click()
        expect(page.locator('#pdf-zoom')).to_have_value('2')
        container.evaluate('el => {el.scrollLeft=0;el.scrollTop=0}')
        page.locator('#pdf-pan').click()
        point = container.bounding_box()
        page.mouse.move(point['x'] + 600, point['y'] + 350)
        page.mouse.down()
        page.mouse.move(point['x'] + 350, point['y'] + 150, steps=8)
        page.mouse.up()
        assert container.evaluate('el => el.scrollLeft') > 100
        assert container.evaluate('el => el.scrollTop') > 100
        container.evaluate('el => el.scrollLeft=el.scrollWidth')
        assert container.evaluate('el => Math.abs(el.scrollLeft - (el.scrollWidth-el.clientWidth))') <= 1
        container.evaluate('el => el.scrollLeft=0')
        assert container.evaluate('el => el.scrollLeft') == 0
        page.locator('#pdf-tool').select_option('3')
        expect(page.locator('#pdf-pan')).to_have_attribute('aria-pressed', 'false')
        page.locator('#pdf-zoom').select_option('page-width')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_function('''() => {
            const el=document.getElementById('pdf-container');
            const canvas=el.querySelector('canvas');
            return canvas && canvas.getBoundingClientRect().width <= el.clientWidth;
        }''')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        bounds = container.bounding_box()
        assert bounds['height'] > 540
        assert bounds['y'] + bounds['height'] <= 844
        browser.close()
