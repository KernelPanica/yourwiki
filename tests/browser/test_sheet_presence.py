import os
from concurrent.futures import ThreadPoolExecutor
from time import monotonic
from threading import Event
import pytest
from playwright.sync_api import expect,sync_playwright
from wiki.services import save_document
from wiki.models import PresenceSession

pytestmark=[pytest.mark.browser,pytest.mark.django_db(transaction=True),
            pytest.mark.skipif(os.environ.get('RUN_BROWSER')!='1',reason='Set RUN_BROWSER=1')]


def login(page,server,username):
    page.goto(server+'/login/')
    page.get_by_label('Username').fill(username)
    page.get_by_label('Password',exact=True).fill('Correct-password-8923')
    page.get_by_role('button',name='Sign in',exact=True).click()


def test_table_presence_uses_stable_cell_ids_and_clears_on_disconnect(realtime_server,workspace):
    doc=save_document(workspace['admin'],'Sheet presence','table','Notes','A\nB\nC',workspace['team'])
    doc.inherit_permissions=False
    doc.policy['group']['write']=True
    doc.save()
    errors=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        a=browser.new_context(viewport={'width':1600,'height':1100}).new_page()
        b=browser.new_context(viewport={'width':1600,'height':1100}).new_page()
        for page,username in [(a,'admin'),(b,'member')]:
            page.on('pageerror',lambda error:errors.append(str(error)))
            login(page,realtime_server,username)
            page.goto(realtime_server+f'/documents/{doc.pk}/live/')
            expect(page.locator('.sheet-host canvas[id^="univer-sheet-main-canvas"]')).to_be_visible(timeout=30000)
        b.bring_to_front()
        canvas=b.locator('.sheet-host canvas[id^="univer-sheet-main-canvas"]')
        canvas.click(position={'x':180,'y':65})
        expect(b.get_by_label('Cell or range address',exact=True)).to_have_value('B2')
        expect(a.locator('.remote-presence-cursor').filter(has_text='Member')).to_be_visible(timeout=15000)
        expected={'kind':'table','sheet_id':'sheet1','row_id':'r1','column_id':'c1','end_row_id':'r1','end_column_id':'c1'}
        # Initial A1 presence is already visible; await this selection's server ack.
        def acknowledged_selection():
            deadline=monotonic()+15
            while True:
                selection=PresenceSession.objects.get(document=doc,user=workspace['member']).selection
                if selection==expected or monotonic()>=deadline:
                    return selection
                Event().wait(.05)
        with ThreadPoolExecutor(max_workers=1) as worker:
            selection=worker.submit(acknowledged_selection).result(timeout=16)
        assert selection==expected
        canvas.click(position={'x':270,'y':90},modifiers=['Shift'])
        try:
            expect(a.locator('.remote-presence-selection').filter(has_text='Member')).to_be_visible(timeout=15000)
        except AssertionError:
            with ThreadPoolExecutor(max_workers=1) as worker:
                current=worker.submit(lambda:PresenceSession.objects.get(document=doc,user=workspace['member']).selection).result()
            raise AssertionError(f'Range presence missing: {current}; browser errors: {errors}')
        # A native range edit rebuilds the peer workbook while its popup is present.
        selected_range=b.get_by_label('Cell or range address',exact=True).input_value()
        a.get_by_label('Cell or range address',exact=True).fill('A1')
        a.get_by_label('Cell or range address',exact=True).press('Enter')
        a.get_by_label('Value or formula',exact=True).fill('Changed while peer selected')
        a.get_by_label('Value or formula',exact=True).press('Enter')
        a.get_by_role('button',name='Save now',exact=True).click()
        expect(a.locator('#sync-status')).to_have_text('Saved to storage',timeout=20000)
        expect(b.get_by_label('Cell or range address',exact=True)).to_have_value(selected_range)
        b.get_by_label('Cell or range address',exact=True).fill('A1')
        b.get_by_label('Cell or range address',exact=True).press('Enter')
        expect(b.get_by_label('Value or formula',exact=True)).to_have_value('Changed while peer selected',timeout=15000)
        b.close()
        expect(a.locator('.remote-presence-cursor').filter(has_text='Member')).to_have_count(0,timeout=10000)
        assert not errors,errors
        browser.close()
