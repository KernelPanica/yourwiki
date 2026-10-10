"""UI errors preserve pending input and permit a deliberate retry."""
import os
import pytest
from playwright.sync_api import expect, sync_playwright
from tests.browser.test_word_editor import login

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_upload_error_retains_file_and_allows_retry(realtime_server, workspace):
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page=browser.new_page()
        login(page,realtime_server,'admin')
        page.goto(realtime_server+'/files/upload/')
        page.locator('#id_file').set_input_files({'name':'retry.txt','mimeType':'text/plain','buffer':b'kept contents'})
        def reject(route):
            if route.request.method=='POST':route.fulfill(status=413,content_type='text/html',body='<h1>nginx 413</h1>')
            else:route.continue_()
        page.route('**/files/upload/',reject)
        button=page.get_by_role('button',name='Upload file',exact=True)
        button.click()
        expect(page.locator('#ui-error')).to_contain_text('The file is too large')
        expect(button).to_be_enabled()
        assert page.locator('#id_file').evaluate('e=>e.files[0].name')=='retry.txt'
        page.unroute('**/files/upload/',reject)
        button.click()
        page.wait_for_url('**/documents/*/')
        expect(page.locator('h1')).to_have_text('retry.txt')
        browser.close()


def test_network_and_unexpected_action_errors_are_visible(realtime_server,workspace):
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page=browser.new_page()
        login(page,realtime_server,'admin')
        page.goto(realtime_server+'/folders/new/')
        page.get_by_label('Name',exact=True).fill('Keep this name')
        def offline(route):
            if route.request.method=='POST':route.abort()
            else:route.continue_()
        page.route('**/folders/new/',offline)
        page.locator('main form button').click()
        expect(page.locator('#ui-error')).to_contain_text('Connection lost')
        expect(page.get_by_label('Name',exact=True)).to_have_value('Keep this name')
        expect(page.locator('main form button')).to_be_enabled()
        page.evaluate("window.yourwikiUI.run(()=>{throw new TypeError('internal details')})")
        expect(page.locator('#ui-error')).to_contain_text('The action could not be completed')
        expect(page.locator('#ui-error')).not_to_contain_text('internal details')
        page.get_by_role('button',name='Dismiss error').click()
        expect(page.locator('#ui-error')).to_be_hidden()
        browser.close()
