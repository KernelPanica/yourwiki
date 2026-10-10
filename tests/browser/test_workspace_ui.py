"""Workspace redesign: navigation, membership, menus, mobile ACLs, and themes."""
import os
from pathlib import Path
import pytest
from playwright.sync_api import expect, sync_playwright
from wiki.models import Folder
from wiki.services import save_document

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_workspace_redesign(realtime_server, workspace):
    folder = Folder.objects.create(name='Команда', owner=workspace['admin'],group=workspace['team'])
    doc = save_document(workspace['admin'], 'План проекта', 'document', 'Work',
                        '# План проекта\n\nСогласовать задачи и подготовить документы.', workspace['team'], folder=folder)
    output = Path('/tmp/yourwiki-ui');output.mkdir(exist_ok=True)
    errors=[]
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width':1440,'height':1000})
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(realtime_server+'/login/')
        page.screenshot(path=str(output/'01-login.png'),full_page=True)
        page.get_by_label('Username').fill('admin')
        page.get_by_label('Password',exact=True).fill('Correct-password-8923')
        page.get_by_role('button',name='Sign in',exact=True).click()
        expect(page).to_have_url(realtime_server+'/folders/')
        page.context.add_cookies([{'name':'django_language','value':'ru','url':realtime_server}])
        page.reload()
        expect(page.locator('[data-nav=files]')).to_have_attribute('aria-current','page')
        page.screenshot(path=str(output/'02-files.png'),full_page=True)
        page.locator('#workspace-search').fill('План')
        page.locator('#workspace-search').press('Enter')
        expect(page.locator('.file-row')).to_have_count(1)
        page.screenshot(path=str(output/'03-search.png'),full_page=True)
        page.locator('.row-menu summary').click()
        expect(page.locator('.row-menu .more-menu-panel')).to_be_visible()
        page.keyboard.press('Escape')
        expect(page.locator('.row-menu')).not_to_have_attribute('open','')
        for index,path in enumerate(['/documents/new/', f'/documents/{doc.pk}/permissions/', '/members/',
                                      '/groups/', f'/groups/{workspace["team"].pk}/', '/settings/', '/mounts/', '/account/'],4):
            page.goto(realtime_server+path)
            if page.locator('#id_permissions_mode').count():page.locator('#id_permissions_mode').select_option('custom')
            page.screenshot(path=str(output/f'{index:02d}-desktop.png'),full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.goto(realtime_server+f'/groups/{workspace["team"].pk}/')
        page.locator('[data-filter-members]').fill('outsider')
        page.locator(f'input[name=members][value="{workspace["outsider"].pk}"]').check()
        page.get_by_role('button',name='Сохранить группу',exact=True).click()
        expect(page.locator(f'input[name=members][value="{workspace["outsider"].pk}"]')).to_be_checked()
        page.goto(realtime_server+f'/members/{workspace["outsider"].pk}/')
        expect(page.locator('input[name=groups]')).to_have_count(0)
        expect(page.locator('.membership-tags')).to_contain_text('team')
        page.goto(realtime_server+'/folders/')
        page.locator('.workspace-menu summary').click()
        page.locator('[data-theme-toggle]').click()
        expect(page.locator('html')).to_have_attribute('data-theme','dark')
        page.screenshot(path=str(output/'12-dark-files.png'),full_page=True)
        page.goto(realtime_server+'/documents/new/')
        page.screenshot(path=str(output/'13-dark-create.png'),full_page=True)
        page.set_viewport_size({'width':390,'height':844})
        page.goto(realtime_server+f'/documents/{doc.pk}/file-settings/')
        page.locator('[name=inherit_permissions]').uncheck()
        expect(page.locator('.responsive-permissions').first).to_be_visible()
        assert page.locator('.responsive-permissions tbody tr').first.evaluate('e => getComputedStyle(e).display') == 'grid'
        page.screenshot(path=str(output/'14-mobile-permissions.png'),full_page=True)
        page.locator('[data-sidebar-open]').click()
        expect(page.locator('.sidebar')).to_have_attribute('aria-hidden','false')
        page.screenshot(path=str(output/'15-mobile-navigation.png'),full_page=True)
        page.keyboard.press('Escape')
        expect(page.locator('.sidebar')).to_have_attribute('aria-hidden','true')
        page.goto(realtime_server+f'/documents/{doc.pk}/')
        page.locator('main .more-menu summary').click()
        panel = page.locator('main .more-menu-panel')
        expect(panel).to_be_visible()
        box=panel.bounding_box()
        assert box['x']>=0 and box['x']+box['width']<=390
        assert box['y']>=0 and box['y']+box['height']<=844
        page.screenshot(path=str(output/'16-mobile-actions.png'),full_page=True)
        page.keyboard.press('Escape')
        expect(panel).to_be_hidden()
        assert not errors,errors
        browser.close()
