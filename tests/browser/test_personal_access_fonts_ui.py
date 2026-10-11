import os
import pytest
from playwright.sync_api import sync_playwright, expect
from tests.browser.test_word_editor import login
from wiki.services import save_document

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True), pytest.mark.skipif(os.environ.get('RUN_BROWSER')!='1',reason='Set RUN_BROWSER=1')]


def test_personal_permissions_form_and_full_font_menu(realtime_server, workspace):
    doc=save_document(workspace['admin'],'Personal and fonts','document','Notes','A font sample',workspace['team'])
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page=browser.new_page(viewport={'width':390,'height':844})
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        login(page,realtime_server,'admin')
        page.goto(realtime_server+f'/documents/{doc.pk}/file-settings/')
        page.locator('[data-inherit-access]').uncheck()
        page.get_by_text('Права отдельных пользователей',exact=True).click()
        page.locator('[data-user-access-search]').fill('outsider')
        key=workspace['outsider'].pk
        page.locator(f'[name="user.{key}.enabled"]').check()
        page.locator(f'[name="user.{key}.write"]').check()
        expect(page.locator(f'[name="user.{key}.read"]')).to_be_checked()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.get_by_role('button',name='Save permissions',exact=True).click()
        page.goto(realtime_server+f'/documents/{doc.pk}/live/')
        fonts=page.get_by_role('combobox',name='Font',exact=True)
        expect(fonts.locator('option[value="Alegreya"]')).to_have_count(1,timeout=15000)
        assert fonts.locator('option').count()>2000
        fonts.select_option('Alegreya')
        page.wait_for_function('document.fonts.check(\'16px "Alegreya"\')',timeout=30000)
        assert not errors
        browser.close()
    doc.refresh_from_db()
    assert doc.allows(workspace['outsider'],'write')
