import os
import pytest
from playwright.sync_api import sync_playwright, expect
from tests.browser.test_word_editor import login

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True), pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_loading_parallel_error_background_and_themes(realtime_server, workspace):
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page=browser.new_page(viewport={'width':390,'height':844})
        errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
        login(page,realtime_server,'admin')
        page.goto(realtime_server+'/folders/')
        page.wait_for_function('!!window.yourwikiLoading')
        panel=page.locator('.loading-indicator')
        page.evaluate('window.endOne=yourwikiLoading.begin();window.endTwo=yourwikiLoading.begin();void 0')
        expect(panel).to_be_visible()
        page.evaluate('endOne();endOne()')
        expect(panel).to_be_visible()
        page.evaluate('endTwo()')
        expect(panel).to_be_hidden()
        page.evaluate("document.documentElement.dataset.theme='dark'")
        page.emulate_media(reduced_motion='reduce')
        page.evaluate('window.endOne=yourwikiLoading.begin();void 0')
        expect(panel).to_be_visible()
        assert page.locator('.loading-spinner').evaluate("el=>getComputedStyle(el).animationName")=='none'
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.evaluate('endOne()')
        # Failed network requests always release the global indicator.
        page.route('**/loading-test',lambda route:route.abort())
        page.evaluate("fetch('/loading-test').catch(()=>{})")
        expect(panel).to_be_hidden()
        # A deliberately slow storage heartbeat remains unobtrusive.
        page.route('**/storage-status',lambda route:route.fulfill(status=200,body='{}',content_type='application/json'))
        page.evaluate("fetch('/api/docs/test/storage-status')")
        expect(panel).to_be_hidden()
        assert not errors
        browser.close()
