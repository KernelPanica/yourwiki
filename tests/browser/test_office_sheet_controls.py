"""Localized formula input, actual recalculation and portable storage."""
import os
import re
import pytest
from playwright.sync_api import expect, sync_playwright
from wiki.services import save_document
from tests.browser.test_word_editor import login

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_russian_formulas_calculate_and_save(realtime_server, workspace):
    doc = save_document(workspace['admin'], 'Russian calculations', 'table', 'Notes',
                        '10\n20', workspace['team'])
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width':1440, 'height':1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        login(page, realtime_server, 'admin')
        page.context.add_cookies([{'name':'django_language','value':'ru','url':realtime_server}])
        page.goto(realtime_server + f'/documents/{doc.pk}/live/')
        expect(page.locator('.sheet-host canvas[id^="univer-sheet-main-canvas"]')).to_be_visible(timeout=30000)
        address = page.get_by_label('Адрес ячейки или диапазона', exact=True)
        formula = page.get_by_label('Значение или формула', exact=True)
        def edit(cell, value):
            address.fill(cell)
            address.press('Enter')
            formula.fill(value)
            formula.press('Enter')
        edit('A1', '10')
        edit('A2', '20')
        edit('B1', '=СУММ(A1:A2)')
        # Read the computed value through a dependent cell, not a mock calculator.
        edit('B2', '=ЕСЛИ(B1=30;"Работает";"Ошибка")')
        address.fill('B1')
        address.press('Enter')
        expect(formula).to_have_value('=СУММ(A1:A2)')
        page.get_by_label('Шрифт', exact=True).select_option('Calibri')
        page.get_by_label('Размер шрифта', exact=True).select_option('18')
        page.get_by_label('Формат числа', exact=True).select_option('0.00')
        page.get_by_label('Формат числа', exact=True).select_option('')
        page.get_by_role('button', name='Сохранить сейчас', exact=True).click()
        expect(page.locator('#sync-status')).to_have_text('Сохранено в хранилище', timeout=20000)
        automatic_export = page.request.get(realtime_server + f'/documents/{doc.pk}/export/')
        assert automatic_export.status == 200
        page.get_by_label('Формат числа', exact=True).select_option('₽#,##0.00')
        page.get_by_role('button', name='Сохранить сейчас', exact=True).click()
        expect(page.locator('#sync-status')).to_have_text(re.compile('^(Сохранено|Синхронизировано).*'), timeout=20000)
        export = page.request.get(realtime_server + f'/documents/{doc.pk}/export/')
        assert export.status == 200
        from wiki.file_formats import read_ods
        from wiki.native import unpack
        snapshot = unpack(read_ods(export.body()))['data']
        cells = next(iter(snapshot['sheets'].values()))['cellData']
        assert cells['0']['1']['f'] == '=SUM(A1:A2)'
        assert cells['0']['1']['v'] == 30
        style = cells['0']['1']['s']
        if isinstance(style, str):
            style = snapshot['styles'][style]
        assert style['ff'] == 'Calibri'
        assert style['fs'] == 18
        assert style['n']['pattern'] == '₽#,##0.00'
        assert cells['1']['1']['f'] == '=IF(B1=30,"Работает","Ошибка")'
        assert cells['1']['1']['v'] == 'Работает'
        page.reload()
        expect(formula).to_be_visible(timeout=30000)
        address.fill('B1')
        address.press('Enter')
        expect(formula).to_have_value('=СУММ(A1:A2)')
        page.locator('.sheet-function-panel summary').click()
        page.get_by_label('Поиск функций', exact=True).fill('СУММЕСЛИ')
        expect(page.locator('.sheet-function-list').get_by_role('button', name='СУММЕСЛИ', exact=True)).to_be_visible()
        page.locator('.sheet-function-panel summary').click()
        native_toolbar=page.locator('.sheet-host [data-u-comp="ribbon-toolbar"]')
        bold=native_toolbar.locator('[data-u-command="sheet.command.set-range-bold"]')
        expect(bold).to_be_visible()
        expect(bold).to_be_enabled()
        bold.click()
        page.get_by_role('button',name='Сохранить сейчас',exact=True).click()
        expect(page.locator('#sync-status')).to_have_text('Сохранено в хранилище',timeout=20000)
        bold_export=page.request.get(realtime_server+f'/documents/{doc.pk}/export/')
        assert bold_export.status==200
        bold_snapshot=unpack(read_ods(bold_export.body()))['data']
        bold_style=next(iter(bold_snapshot['sheets'].values()))['cellData']['0']['1']['s']
        if isinstance(bold_style,str):
            bold_style=bold_snapshot['styles'][bold_style]
        assert bold_style['bl']==1
        page.screenshot(path='/tmp/yourwiki-office-sheet-desktop.png', full_page=True)
        page.set_viewport_size({'width':390, 'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.screenshot(path='/tmp/yourwiki-office-sheet-mobile.png', full_page=True)
        assert not errors, errors
        browser.close()
