import json
import os
import socket
import threading
import time
import pytest
import uvicorn
from django.contrib.staticfiles.handlers import ASGIStaticFilesHandler
from playwright.sync_api import sync_playwright, expect

pytestmark=[pytest.mark.browser,pytest.mark.django_db(transaction=True),pytest.mark.skipif(os.environ.get('RUN_BROWSER')!='1',reason='Set RUN_BROWSER=1')]



def login(page,url,user='admin'):
    page.goto(url+'/login/');page.get_by_label('Username').fill(user);page.get_by_label('Password',exact=True).fill('Correct-password-8923');page.get_by_role('button',name='Sign in',exact=True).click()


def test_rich_collaboration(realtime_server,workspace,document):
    document.policy['group']['write']=True;document.save()
    with sync_playwright() as p:
        browser=p.chromium.launch();a=browser.new_page();b=browser.new_page();errors=[]
        a.on('pageerror',lambda e:errors.append(str(e)));b.on('pageerror',lambda e:errors.append(str(e)))
        login(a,realtime_server);login(b,realtime_server,'member')
        url=realtime_server+f'/documents/{document.pk}/live/'
        a.goto(url);b.goto(url)
        expect(a.locator('.tiptap')).to_contain_text('Some knowledge.')
        expect(b.locator('.tiptap')).to_contain_text('Some knowledge.')
        a.locator('.tiptap').click();a.keyboard.press('Control+End');a.keyboard.type(' Live Alice')
        expect(b.locator('.tiptap')).to_contain_text('Live Alice',timeout=15000)
        b.locator('.tiptap').click();b.keyboard.press('Control+End');b.keyboard.type(' Live Bob')
        expect(a.locator('.tiptap')).to_contain_text('Live Bob',timeout=15000)
        a.reload();expect(a.locator('.tiptap')).to_contain_text('Live Bob')
        a.get_by_label('Comment or suggested replacement').fill('Review this paragraph')
        a.get_by_role('button',name='Comment',exact=True).click()
        expect(b.locator('#review-list')).to_contain_text('Review this paragraph',timeout=15000)
        b.locator('.tiptap').click();b.keyboard.press('Control+End');b.keyboard.press('Control+Shift+Home')
        b.get_by_label('Comment or suggested replacement').fill('Reviewed content')
        b.get_by_role('button',name='Suggest',exact=True).click()
        expect(a.locator('#review-list')).to_contain_text('Reviewed content',timeout=15000)
        a.get_by_role('button',name='accept',exact=True).click()
        expect(b.locator('.tiptap')).to_contain_text('Reviewed content',timeout=15000)
        expect(b.locator('#review-list')).to_contain_text('accepted',timeout=15000)
        a.evaluate('window.scrollTo(0,0)');a.locator('.live-heading h1').click()
        a.screenshot(path='test-results/rich-editor.png',full_page=True)
        assert not errors,errors
        browser.close()


@pytest.mark.parametrize('kind', ['canvas','table','drawio'])
def test_visual_editor_loads(realtime_server,workspace,kind):
    from wiki.services import save_document
    samples={'canvas':json.dumps({'nodes':[{'id':'n','type':'text','text':'Canvas card','x':0,'y':0,'width':200,'height':100}],'edges':[]}),
        'table':'Name,Status\nFeature,Ready',
        'drawio':'<mxfile><diagram id="p1" name="Page 1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" vertex="1" parent="1" value="Architecture"><mxGeometry x="10" y="10" width="200" height="100" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>'}
    doc=save_document(workspace['admin'],kind,kind,'Tests',samples[kind],workspace['team'])
    with sync_playwright() as p:
        browser=p.chromium.launch();page=browser.new_page(viewport={'width':1600,'height':1100});errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        login(page,realtime_server);page.goto(realtime_server+f'/documents/{doc.pk}/live/')
        if kind=='canvas':
            expect(page.locator('.canvas-node')).to_contain_text('Canvas card')
            page.get_by_role('button',name='Add text',exact=True).click()
            page.get_by_label('Text',exact=True).fill('New card')
            page.get_by_role('button',name='Apply',exact=True).click()
            expect(page.locator('.canvas-node')).to_have_count(2)
            expect(page.locator('#sync-status')).to_contain_text('Synced',timeout=15000)
            page.reload();expect(page.locator('.canvas-node')).to_have_count(2)
        elif kind=='table':
            expect(page.locator('.sheet-host canvas').first).to_be_visible(timeout=30000)
            expect(page.locator('#editor-error')).to_be_hidden()
            canvas=page.locator('.sheet-host canvas[id^="univer-sheet-main-canvas"]')
            canvas.click(position={'x':90,'y':40})
            page.keyboard.type('Spreadsheet edit');page.keyboard.press('Enter')
            page.wait_for_function("async (id) => {const d=await (await fetch('/api/docs/'+id)).json();return d.content.includes('Spreadsheet edit');}",arg=str(doc.pk),timeout=15000)
            page.reload();expect(page.locator('.sheet-host canvas').first).to_be_visible(timeout=30000)
            other=browser.new_page(viewport={'width':1600,'height':1100});login(other,realtime_server)
            other.goto(realtime_server+f'/documents/{doc.pk}/live/')
            grid=other.locator('.sheet-host canvas[id^="univer-sheet-main-canvas"]')
            expect(grid).to_be_visible(timeout=30000);grid.click(position={'x':175,'y':40})
            other.keyboard.type('=SUM(2,3)');other.keyboard.press('Enter')
            page.wait_for_function("async (id) => {const d=JSON.parse((await (await fetch('/api/docs/'+id)).json()).content);return Object.values(d.data?.sheets||{}).some(s=>Object.values(s.cellData||{}).some(row=>Object.values(row).some(c=>c.f==='=SUM(2,3)'&&Number(c.v)===5)));}",arg=str(doc.pk),timeout=20000)
            other.close()
        else:
            frame=page.frame_locator('.drawio-frame')
            expect(frame.locator('.geDiagramContainer')).to_be_visible(timeout=45000)
            expect(frame.locator('.geDiagramContainer')).to_contain_text('Architecture',timeout=45000)
            page.wait_for_function("document.querySelector('iframe').contentWindow.yourwikiEditor")
            other=browser.new_page();login(other,realtime_server);other.goto(realtime_server+f'/documents/{doc.pk}/live/')
            expect(other.frame_locator('.drawio-frame').locator('.geDiagramContainer')).to_contain_text('Architecture',timeout=45000)
            page.evaluate("() => {const g=document.querySelector('iframe').contentWindow.yourwikiEditor.editor.graph;g.model.setValue(g.model.getCell('a'),'Collaborative diagram');}")
            expect(other.frame_locator('.drawio-frame').locator('.geDiagramContainer')).to_contain_text('Collaborative diagram',timeout=15000)
            other.close()
        page.screenshot(path=f'test-results/{kind}-editor.png',full_page=True)
        assert not errors,errors
        browser.close()


@pytest.mark.parametrize('language,add_text', [('ru', 'Добавить текст'), ('es', 'Añadir texto')])
def test_localized_canvas_preview(realtime_server, workspace, language, add_text):
    from wiki.services import save_document

    content = json.dumps({'nodes': [
        {'id': 'a', 'type': 'text', 'text': 'Visible card', 'x': -12.5, 'y': 24.75, 'width': 240.5, 'height': 120.25},
        {'id': 'b', 'type': 'text', 'text': 'Second card', 'x': 320.5, 'y': 240.75, 'width': 240.5, 'height': 120.25},
    ], 'edges': [{'id': 'e', 'fromNode': 'a', 'toNode': 'b', 'label': 'Connection'}]})
    doc = save_document(workspace['admin'], 'Localized canvas', 'canvas', 'Tests', content, workspace['team'])
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        login(page, realtime_server)
        page.context.add_cookies([{'name': 'django_language', 'value': language, 'url': realtime_server}])
        page.goto(realtime_server + f'/documents/{doc.pk}/')
        expect(page.locator('html')).to_have_attribute('lang', language)
        expect(page.locator('.node-label').first).to_be_visible()
        expect(page.locator('.node-label').first).to_have_text('Visible card')
        assert page.locator('.graph rect').first.evaluate('(node) => node.width.baseVal.value') == 240.5
        assert page.locator('.graph foreignObject').first.evaluate('(node) => node.width.baseVal.value') == 216.5
        assert page.locator('.graph > text').evaluate('(node) => node.x.baseVal.getItem(0).value') == 274.25
        page.goto(realtime_server + f'/documents/{doc.pk}/live/')
        expect(page.get_by_role('button', name=add_text, exact=True)).to_be_visible()
        expect(page.locator('.canvas-node').first).to_contain_text('Visible card')
        browser.close()


def test_image_view_and_delete(realtime_server, workspace):
    from io import BytesIO
    from PIL import Image
    from wiki.services import save_document
    from wiki.models import Document

    stream = BytesIO()
    Image.new('RGB', (800, 400), 'blue').save(stream, format='PNG')
    doc = save_document(workspace['admin'], 'picture.png', 'file', 'Images', stream.getvalue(), workspace['team'])
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 390, 'height': 844})
        login(page, realtime_server)
        page.context.add_cookies([{'name': 'django_language', 'value': 'ru', 'url': realtime_server}])
        page.goto(realtime_server + f'/documents/{doc.pk}/')
        picture = page.get_by_role('img', name='picture.png')
        expect(picture).to_be_visible()
        assert picture.evaluate('(img) => img.complete && img.naturalWidth === 800')
        assert picture.bounding_box()['width'] <= 390
        for route in ('/', '/?view=grid', '/folders/'):
            page.goto(realtime_server + route)
            button = page.locator(f'a[href="/documents/{doc.pk}/delete/"]')
            expect(button).to_be_visible()
            box = button.bounding_box()
            assert box['x'] >= 0 and box['x'] + box['width'] <= 390
        button.click()
        expect(page.get_by_role('heading', name='Удалить «picture.png»?')).to_be_visible()
        page.get_by_role('button', name='Удалить документ', exact=True).click()
        expect(page).to_have_url(realtime_server + '/')
        browser.close()
    assert not Document.objects.filter(pk=doc.pk).exists()
