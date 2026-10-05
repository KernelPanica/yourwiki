import os
from pathlib import Path
import pytest
from django.contrib.auth.models import Group
from playwright.sync_api import expect, sync_playwright
from wiki.models import Document, Folder

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


@pytest.mark.parametrize('url', ['/documents/new/', '/folders/new/', '/files/upload/'])
def test_creation_permissions_controls(realtime_server, workspace, settings, url):
    settings.CSRF_TRUSTED_ORIGINS = [realtime_server]
    reviewers = Group.objects.create(name='Reviewers')
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width': 360, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(realtime_server + '/login/')
        page.get_by_label('Username').fill('admin')
        page.get_by_label('Password', exact=True).fill('Correct-password-8923')
        page.get_by_role('button', name='Sign in', exact=True).click()
        page.goto(realtime_server + url)
        rules = page.locator('[data-explicit-permissions]')
        expect(rules).to_be_hidden()
        page.locator('#id_permissions_mode').select_option('custom')
        expect(rules).to_be_visible()
        enabled = page.locator(f'#id_permission_team_{reviewers.pk}_enabled')
        read = page.locator(f'#id_permission_team_{reviewers.pk}_read')
        expect(read).to_be_disabled()
        enabled.check()
        expect(read).to_be_enabled()
        expect(read).to_be_checked()
        page.locator(f'#id_permission_team_{reviewers.pk}_write').check()
        page.locator('#id_permissions_mode').select_option('inherit')
        expect(rules).to_be_hidden()
        page.locator('#id_permissions_mode').select_option('custom')
        expect(read).to_be_checked()
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
        assert page.locator('.creation-permissions .permission-table-wrap').evaluate_all(
            'elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1)')
        if url == '/documents/new/':
            page.get_by_label('Title', exact=True).fill('Browser permissions')
            page.locator('#id_kind').select_option('file')
        elif url == '/folders/new/':
            page.get_by_label('Name', exact=True).fill('Browser permissions')
        else:
            page.locator('#id_file').set_input_files({'name': 'Browser permissions',
                                                     'mimeType': 'text/plain', 'buffer': b'content'})
        screenshot = Path('/tmp/yourwiki-permissions-' + url.split('/')[1] + '.png')
        page.locator('h1').click()
        page.evaluate('window.scrollTo(0, 0)')
        page.screenshot(path=str(screenshot), full_page=True)
        page.locator('form button[type=submit], form .form-actions button').last.click()
        page.wait_for_url(lambda value: str(value).rstrip('/') != (realtime_server + url).rstrip('/'))
        assert not errors
        browser.close()
    item = Folder.objects.get(name='Browser permissions') if url == '/folders/new/' else Document.objects.get(title='Browser permissions')
    assert not item.inherit_permissions
    assert item.group_policies[str(reviewers.pk)] == {'visible': True, 'read': True, 'write': True}
