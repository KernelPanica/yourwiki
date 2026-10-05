"""Responsive layout regression with long names and translated controls."""
import os
from pathlib import Path
import pytest
from django.contrib.auth.models import Group
from playwright.sync_api import sync_playwright
from wiki.models import Folder
from wiki.services import save_document

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


GEOMETRY = """() => {
  const issues = [];
  const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && ![...e.closest('body').querySelectorAll('details:not([open])')].some(d => d.contains(e) && !d.querySelector('summary')?.contains(e));
  const label = e => `${e.tagName}.${e.className}: ${(e.innerText || e.name || '').slice(0,60)}`;
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.push(`page width ${document.documentElement.scrollWidth} > ${innerWidth}`);
  for (const container of document.querySelectorAll('.topbar,.heading-row,.heading-actions,.document-toolbar,.document-toolbar>div,.file-row,.directory-row,.form-actions,.admin-fields,.editor-fields,.live-layout,.live-heading')) {
    const children = [...container.children].filter(visible);
    for(let i=0;i<children.length;i++) for(let j=i+1;j<children.length;j++) {
      const a=children[i].getBoundingClientRect(), b=children[j].getBoundingClientRect();
      if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)
        issues.push(`overlap ${label(children[i])} / ${label(children[j])}`);
    }
  }
  for(const e of document.querySelectorAll('main button,main input,main select,main textarea,main .button,.topbar .workspace-menu')) {
    if(!visible(e) || e.closest('.table-scroll,.permission-table-wrap,.pdf-frame')) continue;
    const r=e.getBoundingClientRect();
    if(r.left < -1 || r.right > innerWidth+1) issues.push(`control outside viewport ${label(e)}`);
  }
  return issues;
}"""


def test_responsive_spacing(realtime_server, workspace):
    group = Group.objects.create(name='ОченьДлинноеНазваниеГруппыБезПробелов' * 3)
    folder = Folder.objects.create(name='ОченьДлинноеНазваниеПапкиБезПробелов' * 2,
                                   owner=workspace['admin'], group=group)
    doc = save_document(workspace['admin'], 'ОченьДлинноеНазваниеДокументаБезПробелов' * 2,
                        'document', 'Notes', 'Document content', group, folder=folder)
    paths = ['/', '/folders/', f'/folders/{folder.pk}/', '/documents/new/', '/folders/new/',
             '/files/upload/', '/documents/import/', f'/documents/{doc.pk}/',
             f'/documents/{doc.pk}/edit/', f'/documents/{doc.pk}/live/', f'/documents/{doc.pk}/permissions/',
             f'/folders/{folder.pk}/permissions/', f'/documents/{doc.pk}/file-settings/',
             '/mounts/', '/settings/', '/members/', '/groups/', '/invitations/', '/account/', '/permissions/']
    issues = []
    screenshots = Path('/tmp/yourwiki-layout'); screenshots.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page()
        for width in (320, 1440):
            page.set_viewport_size({'width':width,'height':900})
            page.goto(realtime_server + '/login/')
            issues.extend(f'login {width}: {finding}' for finding in page.evaluate(GEOMETRY))
        page.goto(realtime_server + '/login/')
        page.get_by_label('Username').fill('admin')
        page.get_by_label('Password', exact=True).fill('Correct-password-8923')
        page.get_by_role('button', name='Sign in', exact=True).click()
        for language, width in [('ru',320), ('ru',768), ('en',1024), ('es',1440)]:
            page.context.add_cookies([{'name':'django_language','value':language,'url':realtime_server}])
            page.set_viewport_size({'width':width,'height':900})
            for index, path in enumerate(paths):
                response = page.goto(realtime_server + path)
                assert response.status == 200, (path, response.status)
                page.evaluate('document.fonts.ready')
                if page.locator('#id_permissions_mode').count():
                    page.locator('#id_permissions_mode').select_option('custom')
                findings = page.evaluate(GEOMETRY)
                issues.extend(f'{language} {width} {path}: {finding}' for finding in findings)
                if findings or path in ('/', '/documents/new/', f'/documents/{doc.pk}/permissions/'):
                    page.screenshot(path=str(screenshots/f'{language}-{width}-{index}.png'), full_page=True)
                if page.locator('.directory-menu').count():
                    page.locator('.directory-menu').evaluate('(e) => e.open = true')
                    box = page.locator('.directory-menu-panel').bounding_box()
                    assert box['x'] >= 0 and box['x'] + box['width'] <= width + 1
                    page.locator('.directory-menu').evaluate('(e) => e.open = false')
            # The dropdown and mobile explorer must fit independently.
            page.locator('.workspace-menu').evaluate('(e) => e.open = true')
            box = page.locator('.workspace-menu-panel').bounding_box()
            assert box['x'] >= 0 and box['x'] + box['width'] <= width + 1
            if width <= 800:
                page.locator('.workspace-menu').evaluate('(e) => e.open = false')
                page.locator('[data-sidebar-open]').click()
                assert page.locator('.sidebar').bounding_box()['x'] >= 0
                page.locator('[data-sidebar-close]').first.click()
        browser.close()
    assert not issues, '\n'.join(issues)
