import os
import threading
from unittest.mock import patch
import pytest
from django.test import Client
from playwright.sync_api import sync_playwright,expect
from tests.test_provider_onboarding import cloud
from wiki.models import ProviderIdentity

pytestmark=[pytest.mark.browser,pytest.mark.django_db(transaction=True),pytest.mark.skipif(os.environ.get('RUN_BROWSER')!='1',reason='Set RUN_BROWSER=1')]


def test_pending_cloud_access_shows_progress_then_finishes(realtime_server,workspace):
    released=threading.Event()
    with patch('wiki.provider_grants.reconcile',side_effect=lambda **kwargs:released.wait(20)):
        cloud(workspace)
        user=workspace['member'];user.provider_setup_required=True;user.save(update_fields=['provider_setup_required'])
        ProviderIdentity.objects.create(user=user,provider='google',external_id='confirmed-id',email='member@example.org')
        client=Client();client.force_login(user)
        session=client.session;session['provider_setup_waiting']=True;session.save()
        try:
            with sync_playwright() as p:
                browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
                page=browser.new_page(viewport={'width':390,'height':900});errors=[]
                page.on('pageerror',lambda error:errors.append(str(error)))
                page.context.add_cookies([{'name':'sessionid','value':client.cookies['sessionid'].value,'url':realtime_server}])
                page.goto(realtime_server+'/account/setup/')
                expect(page.locator('#provider-sync-progress')).to_be_visible()
                expect(page.locator('#provider-setup-finish button')).to_be_disabled()
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                page.screenshot(path='/tmp/yourwiki-background-onboarding.png')
                released.set()
                page.wait_for_url(realtime_server+'/',timeout=15000)
                user.refresh_from_db();assert not user.provider_setup_required
                assert not errors,errors
                browser.close()
        finally:released.set()
