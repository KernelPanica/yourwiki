import os
import pytest
from playwright.sync_api import sync_playwright, expect
from tests.browser.test_word_editor import login
from wiki.models import SiteConfiguration
from wiki.services import save_document
from wiki.storage import active_storage

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True), pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_versions_preview_and_restore_on_mobile(realtime_server, workspace):
    SiteConfiguration.objects.update_or_create(pk=1, defaults={'revision_history': True})
    doc = save_document(workspace['admin'], 'Version test', 'document', 'Notes', 'Original version text', workspace['team'])
    original = active_storage().read(doc.reference)
    doc = save_document(workspace['admin'], doc.title, doc.kind, doc.collection, 'Changed version text', doc.group, doc, doc.revision)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width':390, 'height':844})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        login(page, realtime_server, 'admin')
        page.goto(realtime_server+f'/documents/{doc.pk}/')
        page.locator('[data-version-panel]>summary').click()
        page.get_by_role('link', name='Просмотреть', exact=True).click()
        expect(page.locator('.preview')).to_contain_text('Original version text')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.get_by_role('button', name='Восстановить эту версию').click()
        expect(page).to_have_url(realtime_server+f'/documents/{doc.pk}/')
        expect(page.locator('.preview')).to_contain_text('Original version text')
        assert not errors
        browser.close()
    doc.refresh_from_db()
    assert active_storage().read(doc.reference) == original
