import os
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright, expect
from wiki.models import Folder, Document

pytestmark=[pytest.mark.browser,pytest.mark.django_db(transaction=True),
            pytest.mark.skipif(os.environ.get('RUN_BROWSER')!='1',reason='Set RUN_BROWSER=1')]


def test_simple_creation_and_rw_settings(realtime_server,workspace):
    folder=Folder.objects.create(name='Access folder',owner=workspace['admin'],group=workspace['team'])
    output=Path('/tmp/yourwiki-rw');output.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page=browser.new_page(viewport={'width':1440,'height':1000})
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(realtime_server+'/login/')
        page.get_by_label('Username').fill('admin')
        page.get_by_label('Password',exact=True).fill('Correct-password-8923')
        page.get_by_role('button',name='Sign in',exact=True).click()
        page.goto(realtime_server+f'/documents/new/?folder={folder.pk}')
        expect(page.locator('[name="group"]')).to_have_count(0)
        expect(page.locator('[name^="permission_"]')).to_have_count(0)
        page.get_by_label('Title',exact=True).fill('Simple RW')
        page.screenshot(path=str(output/'create.png'),full_page=True)
        page.get_by_role('button',name='Create and open editor',exact=True).click()
        page.wait_for_url('**/live/')
        doc_id=page.url.split('/documents/')[1].split('/')[0]
        doc=page.request.get(realtime_server+f'/api/docs/{doc_id}').json()
        assert doc['folder']==str(folder.pk) and doc['inherit_permissions']
        for url in [f'/documents/{doc_id}/file-settings/',f'/folders/{folder.pk}/file-settings/']:
            page.goto(realtime_server+url)
            expect(page.locator('[data-own-access]')).to_be_hidden()
            page.locator('[name="inherit_permissions"]').uncheck()
            read=page.locator('[name="group.read"]');write=page.locator('[name="group.write"]')
            write.check();expect(read).to_be_checked()
            read.uncheck();expect(write).not_to_be_checked()
            write.check()
            page.get_by_role('button',name='Save permissions',exact=True).click()
            expect(write).to_be_checked();expect(read).to_be_checked()
            for width in [1440,390,320]:
                page.set_viewport_size({'width':width,'height':1000})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                expect(write).to_be_visible();expect(read).to_be_visible()
                page.evaluate('document.activeElement?.blur();window.scrollTo(0,0)')
                page.screenshot(path=str(output/f'{"folder" if "/folders/" in url else "file"}-{width}.png'),full_page=True)
        assert not errors,errors
        browser.close()
