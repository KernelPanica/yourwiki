import json
import os
from unittest.mock import patch
import pytest
from playwright.sync_api import sync_playwright,expect
from wiki.services import save_document
from tests.browser.test_word_editor import login

pytestmark=[pytest.mark.browser,pytest.mark.django_db(transaction=True),pytest.mark.skipif(os.environ.get('RUN_BROWSER')!='1',reason='Set RUN_BROWSER=1')]


@pytest.mark.parametrize('width',[1440,390])
def test_embedded_slides_and_simple_admin_trash(realtime_server,workspace,settings,width):
    from wiki.trash import trash_document
    doc=save_document(workspace['admin'],'Slide viewer','presentation','Notes','A slide',workspace['team'])
    settings.COLLABORA_URL=settings.COLLABORA_WOPI_URL=realtime_server
    actor=workspace['member'];actor.is_simple_admin=True;actor.save(update_fields=['is_simple_admin'])
    entry=trash_document(actor,save_document(workspace['admin'],'Trashed','document','Notes','Text',workspace['team']))
    with patch('wiki.collabora.editor_action',return_value=realtime_server+'/health/'),sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page=browser.new_page(viewport={'width':width,'height':900})
        page.route('**/health/**',lambda route:route.fulfill(content_type='text/html',body='<html><body>Slides frame</body></html>'))
        errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
        login(page,realtime_server,'member')
        page.goto(realtime_server+f'/documents/{doc.pk}/')
        expect(page.locator('#presentation-preview')).to_be_visible()
        frame=page.frame_locator('#presentation-preview')
        expect(frame.locator('#office-frame')).to_be_visible()
        assert frame.locator('#office-bootstrap').text_content()
        assert json.loads(frame.locator('#office-bootstrap').text_content())['write'] is False
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        page.screenshot(path=f'/tmp/yourwiki-slides-view-{width}.png')
        page.goto(realtime_server+f'/trash/{entry.pk}/')
        expect(page.get_by_role('button',name='Restore',exact=True)).to_be_visible()
        expect(page.get_by_role('button',name='Permanently delete',exact=True)).to_have_count(0)
        assert not errors,errors
        browser.close()
