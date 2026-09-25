import json
import os
from pathlib import Path
from urllib.parse import urlparse
import pytest
from playwright.sync_api import sync_playwright, expect

pytestmark=[pytest.mark.browser,pytest.mark.django_db(transaction=True),pytest.mark.skipif(os.environ.get('RUN_BROWSER')!='1',reason='Set RUN_BROWSER=1 to run browser acceptance tests')]

def test_workspace_and_registration(realtime_server,workspace,settings):
    from types import SimpleNamespace
    live_server=SimpleNamespace(url=realtime_server)
    settings.PUBLIC_URL=live_server.url
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        page=browser.new_page(viewport={'width':1440,'height':1100})
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        response=page.goto(live_server.url+'/')
        assert response.status==500
        expect(page.get_by_role('heading',name='Server error')).to_be_visible()
        assert page.locator('form').count()==0
        page.goto(live_server.url+'/login/')
        page.get_by_label('Username').fill('admin')
        page.get_by_label('Password',exact=True).fill('Correct-password-8923')
        page.get_by_role('button',name='Sign in',exact=True).click()
        expect(page.get_by_role('heading',name='All documents',exact=True)).to_be_visible()
        page.get_by_role('link',name='New document',exact=True).click()
        page.get_by_label('Title',exact=True).fill('Team handbook')
        page.get_by_text('Advanced: initial content / source',exact=True).click()
        page.get_by_label('Content',exact=True).fill('# Our handbook\n\nUseful team knowledge.')
        page.get_by_role('button',name='Create and open editor',exact=True).click()
        expect(page.locator('.tiptap')).to_contain_text('Useful team knowledge')
        doc_url=page.url.removesuffix('live/')
        page.locator('.tiptap').click();page.keyboard.press('Control+End');page.keyboard.type(' Updated knowledge.')
        expect(page.locator('#sync-status')).to_contain_text('Synced',timeout=15000)
        page.goto(doc_url)
        expect(page.locator('.preview')).to_contain_text('Updated knowledge.')
        page.goto(live_server.url+'/')
        page.get_by_label('Search documents').fill('handbook')
        page.get_by_role('button',name='Search',exact=True).click()
        expect(page.locator('.file-row')).to_have_count(1)
        page.goto(live_server.url+'/invitations/')
        page.get_by_label('team',exact=True).check()
        page.get_by_role('button',name='Create invitation',exact=True).click()
        invite=page.get_by_label('Invitation link').input_value()
        context=browser.new_context()
        newcomer=context.new_page()
        newcomer.goto(invite)
        newcomer.get_by_label('Username',exact=True).fill('invitedmember')
        newcomer.get_by_label('Display name',exact=True).fill('Invited Member')
        newcomer.get_by_label('Password',exact=True).fill('Secure-invited-password-6782')
        newcomer.get_by_label('Password confirmation',exact=True).fill('Secure-invited-password-6782')
        newcomer.get_by_role('button',name='Join workspace').click()
        expect(newcomer.get_by_role('heading',name='All documents',exact=True)).to_be_visible()
        assert newcomer.goto(doc_url).status==200
        assert newcomer.goto(doc_url+'edit/').status==500
        page.goto(doc_url+'permissions/')
        page.get_by_label('group read',exact=True).uncheck()
        page.get_by_role('button',name='Save permissions').click()
        assert newcomer.goto(doc_url).status==500
        page.goto(live_server.url+'/')
        output=Path('test-results');output.mkdir(exist_ok=True)
        page.screenshot(path=str(output/'desktop.png'),full_page=True)
        page.set_viewport_size({'width':320,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.screenshot(path=str(output/'mobile.png'),full_page=True)
        assert not errors,errors
        context.close();browser.close()


def test_diagrams_and_table(live_server,workspace):
    from wiki.services import save_document
    samples={
        'canvas':json.dumps({'nodes':[{'id':'a','type':'text','text':'Connected idea','x':0,'y':0,'width':200,'height':100}],'edges':[]}),
        'drawio':'<mxfile><diagram><mxGraphModel><root><mxCell id="a" vertex="1" value="Architecture"><mxGeometry x="10" y="10" width="200" height="100"/></mxCell></root></mxGraphModel></diagram></mxfile>',
        'table':'Name,Status\nFeature,Ready',
    }
    docs=[save_document(workspace['admin'],k,k,'Engineering',v,workspace['team']) for k,v in samples.items()]
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        page=browser.new_page()
        page.goto(live_server.url+'/login/')
        page.get_by_label('Username').fill('admin');page.get_by_label('Password',exact=True).fill('Correct-password-8923')
        page.get_by_role('button',name='Sign in',exact=True).click()
        for doc in docs:
            page.goto(live_server.url+f'/documents/{doc.pk}/')
            if doc.kind=='table':expect(page.locator('.csv-table')).to_contain_text('Feature')
            else:
                expect(page.locator('.graph rect')).to_have_count(1)
                page.get_by_role('button',name='Zoom in').click()
                assert page.locator('.graph').evaluate('(el) => el.style.width')=='125%'
        browser.close()


def test_explorer_and_workspace_menu(realtime_server, workspace):
    from wiki.models import Folder
    from wiki.services import save_document
    directory = Folder.objects.create(name='Project files', owner=workspace['admin'], group=workspace['team'])
    doc = save_document(workspace['admin'], 'Explorer document', 'document', 'Notes', '# Example', workspace['team'])
    doc.folder = directory
    doc.save(update_fields=['folder'])
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width':1280,'height':900})
        page.goto(realtime_server+'/login/')
        page.get_by_label('Username').fill('admin')
        page.get_by_label('Password', exact=True).fill('Correct-password-8923')
        page.get_by_role('button', name='Sign in', exact=True).click()
        explorer = page.get_by_role('navigation', name='Files and directories')
        expect(explorer.get_by_role('link', name='Project files', exact=True)).to_be_visible()
        expect(explorer.get_by_role('link', name='Explorer document', exact=True)).to_be_visible()
        branch = page.locator(f'.explorer-branch[data-folder-id="{directory.pk}"]')
        branch.evaluate('(element) => { element.open = false; }')
        expect(branch).not_to_have_attribute('open', '')
        page.wait_for_function(f"sessionStorage.getItem('yourwiki:directory:{directory.pk}') === 'closed'")
        page.reload()
        expect(branch).not_to_have_attribute('open', '')
        expect(page.get_by_role('link', name='Site administration', exact=True)).not_to_be_visible()
        page.locator('.workspace-menu > summary').click()
        expect(page.get_by_role('link', name='Site administration', exact=True)).to_be_visible()
        page.keyboard.press('Escape')
        expect(page.locator('.workspace-menu')).not_to_have_attribute('open', '')
        page.set_viewport_size({'width':320,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.get_by_role('button', name='Open file explorer').click()
        explorer.get_by_role('link', name='Project files', exact=True).click()
        expect(page.get_by_role('heading', name='Project files', exact=True)).to_be_visible()
        page.locator('.workspace-menu > summary').click()
        page.get_by_role('link', name='Site administration', exact=True).click()
        expect(page.get_by_role('heading', name='Site administration', exact=True)).to_be_visible()
        browser.close()


def test_drag_and_path_creation(realtime_server, workspace):
    from wiki.models import Document, Folder
    from wiki.services import save_document
    destination = Folder.objects.create(name='Projects', owner=workspace['admin'], group=workspace['team'])
    source_directory = Folder.objects.create(name='Drag folder', owner=workspace['admin'], group=workspace['team'])
    doc = save_document(workspace['admin'], 'Drag me', 'document', 'Notes', '', workspace['team'])
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(realtime_server+'/login/')
        page.get_by_label('Username').fill('admin')
        page.get_by_label('Password', exact=True).fill('Correct-password-8923')
        page.get_by_role('button', name='Sign in', exact=True).click()
        page.locator(f'main [data-move-url="/move/document/{doc.pk}/"]').drag_to(page.locator(f'#workspace-sidebar [data-drop-folder="{destination.pk}"]'))
        page.wait_for_url(f'**/folders/{destination.pk}/')
        expect(page.locator('.explorer-card .quick-card', has_text='Drag me')).to_be_visible()
        page.locator(f'[data-move-url="/move/folder/{source_directory.pk}/"]').drag_to(page.locator(f'#workspace-sidebar [data-drop-folder="{destination.pk}"]'))
        expect(page.locator('.explorer-card .quick-card', has_text='Drag folder')).to_be_visible()
        page.locator('.explorer-actions').get_by_role('link', name='New directory', exact=True).click()
        page.get_by_label('Name', exact=True).fill('Empty files')
        page.get_by_label('Parent path').fill('/Projects')
        page.get_by_role('button', name='Create directory', exact=True).click()
        expect(page.get_by_role('heading', name='Empty files', exact=True)).to_be_visible()
        page.get_by_role('link', name='New file here', exact=True).click()
        expect(page.get_by_label('Path', exact=True)).to_have_value('/Projects/Empty files')
        page.get_by_label('Title', exact=True).fill('blank.txt')
        page.get_by_label('Kind', exact=True).select_option('file')
        page.get_by_role('button', name='Create file', exact=True).click()
        expect(page.get_by_role('link', name='Download file', exact=True)).to_be_visible()
        with page.expect_navigation():
            page.evaluate('''selector => {
            const transfer = new DataTransfer();
            transfer.items.add(new File([new Uint8Array([0, 255])], 'dropped.zip', {type:'application/zip'}));
            const target = document.querySelector(selector);
            target.dispatchEvent(new DragEvent('dragover', {bubbles:true, cancelable:true, dataTransfer:transfer}));
            target.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:transfer}));
            }''', f'#workspace-sidebar [data-drop-path="/Projects/Empty files"]')
        expect(page.get_by_role('heading', name='Empty files', exact=True)).to_be_visible()
        expect(page.locator('.explorer-card .quick-card', has_text='dropped.zip')).to_be_visible()
        page.goto(realtime_server+'/files/upload/?path=/Projects/Empty%20files')
        page.get_by_label('File', exact=True).set_input_files({'name':'example.pdf','mimeType':'application/pdf','buffer':b'%PDF-1.4 example'})
        page.get_by_role('button', name='Upload file', exact=True).click()
        expect(page.get_by_role('heading', name='example.pdf')).to_be_visible()
        with page.expect_download() as download:
            page.get_by_role('link', name='Download file', exact=True).click()
        assert download.value.suggested_filename == 'example.pdf'
        browser.close()
    doc.refresh_from_db()
    source_directory.refresh_from_db()
    assert doc.folder_id == destination.pk
    assert source_directory.parent_id == destination.pk
    assert Document.objects.get(title='blank.txt').folder.name == 'Empty files'


def test_mountpoint_interface(realtime_server, workspace, tmp_path):
    from wiki.models import MountPoint
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width':1440, 'height':1000})
        page.goto(realtime_server+'/login/')
        page.get_by_label('Username').fill('admin')
        page.get_by_label('Password', exact=True).fill('Correct-password-8923')
        page.get_by_role('button', name='Sign in', exact=True).click()
        page.goto(realtime_server+'/mounts/')
        page.get_by_label('Mount path', exact=True).fill('/Projects/Archive')
        page.get_by_label('Directory inside the Docker container', exact=True).fill(str(tmp_path/'archive'))
        page.get_by_role('button', name='Connect mount', exact=True).click()
        expect(page.locator('.mount-card h2', has_text='/Projects/Archive')).to_be_visible()
        page.screenshot(path='test-results/mounts.png', full_page=True)
        mount_url = page.locator('.mount-card h2 a', has_text='/Projects/Archive').get_attribute('href')
        page.goto(realtime_server+mount_url)
        page.get_by_role('link', name='New file here', exact=True).click()
        page.get_by_label('Title', exact=True).fill('Mounted note')
        page.get_by_role('button', name='Create and open editor', exact=True).click()
        expect(page.locator('.tiptap')).to_be_visible()
        page.goto(realtime_server+mount_url)
        expect(page.locator('main .file-name', has_text='Mounted note')).to_be_visible()
        page.screenshot(path='test-results/filesystem.png', full_page=True)
        page.set_viewport_size({'width':320,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.get_by_role('button', name='Open file explorer').click()
        expect(page.get_by_role('navigation', name='Files and directories')).to_be_visible()
        page.screenshot(path='test-results/filesystem-mobile.png', full_page=True)
        browser.close()
