import os
import json
import shutil
import hashlib
from pathlib import Path
import pytest
from django.contrib.staticfiles import finders
from playwright.sync_api import sync_playwright, expect
from tests.browser.test_word_editor import login
from wiki.services import save_document
from wiki.native import pack

pytestmark=[pytest.mark.browser,pytest.mark.django_db(transaction=True),pytest.mark.skipif(os.environ.get('RUN_BROWSER')!='1',reason='Set RUN_BROWSER=1')]


def test_preview_loads_used_font_and_reflows_pages(realtime_server,workspace,settings,tmp_path):
    settings.GOOGLE_FONTS_DIR=tmp_path
    target=tmp_path/'google/anton/Anton.ttf';target.parent.mkdir(parents=True)
    shutil.copyfile(finders.find('wiki/fonts/office/anton/Anton-Regular.ttf'),target)
    stamp=hashlib.sha256(target.read_bytes()).hexdigest()
    (tmp_path/'google-fonts.json').write_text(json.dumps({'families':[{'name':'Anton','fonts':[{'path':'google/anton/Anton.ttf','stamp':stamp,'weight':'400','style':'normal'}]}]}))
    content=pack('document',{'type':'doc','content':[{'type':'paragraph','content':[{'type':'text','text':'Проверка кириллицы Ёжик '+('Длинный текст '*150),'marks':[{'type':'textStyle','attrs':{'fontFamily':'Anton'}}]}]}]})
    doc=save_document(workspace['admin'],'Font preview','document','Notes',content,workspace['team'])
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page=browser.new_page(viewport={'width':1440,'height':1000})
        login(page,realtime_server,'admin')
        page.goto(realtime_server+f'/documents/{doc.pk}/')
        paper=page.locator('.paged-document')
        expect(paper.locator('[style*="font-family:Anton"]')).to_be_visible()
        page.wait_for_function('''() => [...document.fonts].some(face=>face.family==='Anton' && face.status==='loaded')''')
        expect(paper).to_have_attribute('data-pages',__import__('re').compile('[1-9][0-9]*'))
        assert page.evaluate("document.fonts.check('16px Anton','Привет Ёё')")
        expect(paper).to_contain_text('Проверка кириллицы Ёжик')
        browser.close()
