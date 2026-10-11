import os
import pytest
from playwright.sync_api import sync_playwright, expect
from tests.browser.test_word_editor import login
from tests.test_requested_ui_features import tree

pytestmark=[pytest.mark.browser,pytest.mark.django_db(transaction=True),
            pytest.mark.skipif(os.environ.get('RUN_BROWSER')!='1',reason='Set RUN_BROWSER=1')]


def test_account_link_shows_progress_and_recovers_after_failure(realtime_server,workspace):
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page=browser.new_page();login(page,realtime_server,'member')
        page.goto(realtime_server+'/account/providers/google/callback/?state=s&code=c')
        pending=[]
        page.route('**/account/providers/google/callback/',lambda route:pending.append(route))
        page.get_by_label('Display name').fill('Member')
        page.get_by_role('button',name='Finish connecting',exact=True).click()
        expect(page.locator('.form-progress')).to_be_visible()
        expect(page.locator('.form-progress')).to_contain_text('synchronizing access')
        expect(page.get_by_role('button',name='Finish connecting',exact=True)).to_be_disabled()
        assert pending
        pending[0].fulfill(status=503,content_type='application/json',body='{"error":"Storage temporarily unavailable"}')
        expect(page.locator('#ui-error')).to_contain_text('Storage temporarily unavailable')
        expect(page.locator('.form-progress')).to_have_count(0)
        expect(page.get_by_role('button',name='Finish connecting',exact=True)).to_be_enabled()
        expect(page.get_by_label('Display name')).to_have_value('Member')
        browser.close()


def test_recursive_deletion_confirmation_and_mobile_layout(realtime_server,workspace):
    parent,child,docs=tree(workspace)
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page=browser.new_page(viewport={'width':390,'height':844});login(page,realtime_server,'admin')
        page.goto(realtime_server+f'/folders/{parent.pk}/delete/')
        expect(page.locator('main')).to_contain_text('2 files and 1 nested folders')
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        page.locator('[name=confirm]').check()
        with page.expect_response(lambda response:response.request.method=='POST') as saved:
            page.get_by_role('button',name='Move folder and files to trash',exact=True).click()
        assert saved.value.status==302
        page.wait_for_url(realtime_server+'/folders/')
        expect(page.locator('main')).not_to_contain_text('Delete parent')
        assert (workspace['root']/'Delete parent').exists()
        browser.close()
