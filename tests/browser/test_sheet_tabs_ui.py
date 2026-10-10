import os
import re

import pytest
from playwright.sync_api import expect, sync_playwright

from wiki.services import save_document

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_visual_editor_adds_renames_reorders_and_deletes_persisted_worksheets(realtime_server, workspace):
    doc = save_document(workspace['admin'], 'Worksheet mechanics', 'table', 'Notes', 'Value\nKeep', workspace['team'])
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width': 1600, 'height': 1100})
        page.set_default_timeout(10000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(realtime_server + '/login/')
        page.get_by_label('Username').fill('admin')
        page.get_by_label('Password', exact=True).fill('Correct-password-8923')
        page.get_by_role('button', name='Sign in', exact=True).click()
        page.goto(realtime_server + f'/documents/{doc.pk}/live/')
        expect(page.locator('.sheet-host canvas[id^="univer-sheet-main-canvas"]')).to_be_visible(timeout=30000)
        tabs = page.locator('.sheet-host [data-u-comp="slide-tab-item"]')
        expect(tabs).to_have_count(1)
        page.locator('[data-u-comp="sheet-bar-append-button"]').first.click()
        expect(tabs).to_have_count(2)
        added = tabs.nth(1)
        added.click(button='right')
        page.locator('span:not(:has(span))').filter(has_text=re.compile(r'^Rename$')).click()
        rename = tabs.locator('[contenteditable="true"]')
        expect(rename).to_be_visible()
        rename.fill('Forecast')
        rename.press('Enter')
        expect(page.get_by_role('tab', name='Forecast', exact=True)).to_be_visible()
        forecast_box = page.get_by_role('tab', name='Forecast', exact=True).bounding_box()
        original_box = tabs.first.bounding_box()
        page.mouse.move(forecast_box['x'] + forecast_box['width'] / 2, forecast_box['y'] + forecast_box['height'] / 2)
        page.mouse.down()
        expect(page.get_by_role('tab', name='Forecast', exact=True)).to_have_css('cursor', 'move')
        page.mouse.move(original_box['x'] + 3, original_box['y'] + original_box['height'] / 2, steps=12)
        page.mouse.up()
        expect(tabs.first).to_have_text('Forecast')
        page.get_by_role('button', name='Save now', exact=True).click()
        expect(page.locator('#sync-status')).to_have_text('Saved to storage', timeout=15000)
        page.reload()
        forecast = page.get_by_role('tab', name='Forecast', exact=True)
        expect(forecast).to_be_visible(timeout=30000)
        expect(tabs.first).to_have_text('Forecast')
        forecast.click(button='right')
        page.locator('span:not(:has(span))').filter(has_text=re.compile(r'^Delete$')).click()
        page.get_by_role('button', name='OK', exact=True).click()
        expect(tabs).to_have_count(1)
        page.get_by_role('button', name='Save now', exact=True).click()
        expect(page.locator('#sync-status')).to_have_text('Saved to storage', timeout=15000)
        page.reload()
        expect(page.get_by_role('tab', name='Sheet 1', exact=True)).to_be_visible(timeout=30000)
        expect(tabs).to_have_count(1)
        page.goto(realtime_server + f'/documents/{doc.pk}/')
        expect(page.get_by_role('cell', name='Keep', exact=True)).to_be_attached()
        assert not errors
        browser.close()
