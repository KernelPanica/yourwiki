import os

import pytest
from playwright.sync_api import expect, sync_playwright
from wiki.services import save_document

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def login(page, server, username):
    page.goto(server + '/login/')
    page.get_by_label('Username').fill(username)
    page.get_by_label('Password', exact=True).fill('Correct-password-8923')
    page.get_by_role('button', name='Sign in', exact=True).click()


def test_text_presence_readonly_selection_disconnect(realtime_server, workspace):
    doc = save_document(workspace['admin'], 'Presence document', 'document', 'Notes',
                        'Stable paragraph for cursor testing.', workspace['team'], file_format='md')
    doc.inherit_permissions = False
    doc.save()
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        context_a, context_b = browser.new_context(), browser.new_context()
        a, b = context_a.new_page(), context_b.new_page()
        for page in (a, b):
            page.on('pageerror', lambda error: errors.append(str(error)))
        login(a, realtime_server, 'admin')
        login(b, realtime_server, 'member')
        url = realtime_server + f'/documents/{doc.pk}/live/'
        a.goto(url)
        b.goto(url)
        expect(a.locator('.presence-chip').filter(has_text='Member')).to_be_visible(timeout=15000)
        reader = b.locator('.document-host .tiptap')
        expect(reader).to_have_attribute('contenteditable', 'false')
        reader.evaluate('''el => {
          const text=el.querySelector('p').firstChild, range=document.createRange();
          range.setStart(text, 2);range.setEnd(text, 10);
          const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
          el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
          document.dispatchEvent(new Event('selectionchange'));
        }''')
        expect(a.locator('.remote-presence-selection')).to_be_visible(timeout=15000)
        expect(a.locator('.remote-presence-cursor').filter(has_text='Member')).to_be_visible(timeout=15000)
        selected_text = a.locator('.remote-presence-selection').inner_text()
        a.locator('.document-host .tiptap').click()
        a.keyboard.press('Control+Home'); a.keyboard.type('Before ')
        expect(a.locator('.remote-presence-selection')).to_have_text(selected_text)
        b.close()
        expect(a.locator('.presence-chip').filter(has_text='Member')).to_have_count(0, timeout=10000)
        expect(a.locator('.remote-presence-cursor')).to_have_count(0)
        assert not errors, errors
        browser.close()


def test_unknown_write_pauses_autosave_and_allows_manual_retry(realtime_server, workspace):
    import hashlib
    from wiki.collaboration import ensure_room
    from wiki.models import SaveSession
    from wiki.storage import active_storage
    doc = save_document(workspace['admin'], 'Unknown result', 'document', 'Notes',
                        'Original content', workspace['team'], file_format='md')
    room = ensure_room(doc)
    payload = room.snapshot.encode()
    SaveSession.objects.create(document=doc, author=workspace['admin'], client_id='collaboration',
        base_revision=doc.revision, base_etag=doc.storage_digest, payload=payload,
        payload_hash=hashlib.sha256(payload).hexdigest(), state='unknown', error='Verify the write result before retrying.')
    _, ref = active_storage().reference(doc.reference)
    base_path = workspace['root'] / ref
    original = base_path.read_bytes()
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page()
        login(page, realtime_server, 'admin')
        page.goto(realtime_server + f'/documents/{doc.pk}/live/')
        expect(page.locator('#sync-status')).to_have_text('Write result unknown · automatic saving paused')
        editor = page.locator('.document-host .tiptap')
        editor.click(); page.keyboard.press('Control+End'); page.keyboard.type(' Pending new edits')
        # Exercise the debounce interval: provider bytes must stay untouched.
        page.wait_for_timeout(2200)
        expect(page.locator('#sync-status')).to_have_text('Write result unknown · automatic saving paused')
        assert base_path.read_bytes() == original
        page.locator('#save-live').click()
        expect(page.locator('#sync-status')).to_have_text('Saved to storage', timeout=15000)
        expect(page.locator('#editor-error')).to_be_hidden()
        assert b'Pending new edits' in base_path.read_bytes()
        browser.close()
