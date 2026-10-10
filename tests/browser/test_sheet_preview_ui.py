import os

import pytest
from playwright.sync_api import expect, sync_playwright

from wiki.native import pack
from wiki.services import save_document

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_saved_worksheets_have_coordinates_and_keyboard_tabs(realtime_server, workspace):
    content = pack('table', {'id': 'book', 'sheetOrder': ['one', 'two'], 'sheets': {
        'one': {'id': 'one', 'name': 'January', 'rowCount': 3, 'columnCount': 2,
                'cellData': {'0': {'0': {'v': 'First data row'}}, '2': {'1': {'v': 42}}}},
        'two': {'id': 'two', 'name': 'February', 'rowCount': 2, 'columnCount': 28,
                'cellData': {'1': {'27': {'v': '<script>literal</script>'}}}},
    }})
    doc = save_document(workspace['admin'], 'Monthly book', 'table', 'Notes', content, workspace['team'])
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(realtime_server + '/login/')
        page.get_by_label('Username').fill('admin')
        page.get_by_label('Password', exact=True).fill('Correct-password-8923')
        page.get_by_role('button', name='Sign in', exact=True).click()
        page.goto(realtime_server + f'/documents/{doc.pk}/')
        expect(page.get_by_role('columnheader', name='A', exact=True)).to_be_visible()
        expect(page.get_by_role('rowheader', name='3', exact=True)).to_be_visible()
        expect(page.get_by_role('cell', name='First data row', exact=True)).to_be_visible()
        january = page.get_by_role('tab', name='January', exact=True)
        january.focus()
        january.press('ArrowRight')
        february = page.get_by_role('tab', name='February', exact=True)
        expect(february).to_be_focused()
        expect(february).to_have_attribute('aria-selected', 'true')
        expect(page.get_by_role('columnheader', name='AB', exact=True)).to_be_attached()
        expect(page.get_by_role('cell', name='<script>literal</script>', exact=True)).to_be_attached()
        expect(page.locator('table script')).to_have_count(0)
        january.click()
        expect(page.get_by_role('cell', name='42', exact=True)).to_be_visible()
        assert not errors
        browser.close()
