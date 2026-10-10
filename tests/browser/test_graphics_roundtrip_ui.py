import base64
import json
import os
from pathlib import Path
import time
import pytest
from playwright.sync_api import sync_playwright, expect
from tests.test_graphics_roundtrip import XML

pytestmark = [pytest.mark.browser, pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def bounds(locator):
    expect(locator).to_be_visible()
    return locator.evaluate('el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}')


def test_diagram_browser_and_server_preserve_xml_envelopes():
    from wiki.collaboration import diagram_data, diagram_xml, diagram_parse, element_data
    source = Path('frontend/diagram-xml.js').read_bytes()
    module = 'data:text/javascript;base64,' + base64.b64encode(source).decode()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page()
        result = page.evaluate('''async ({module,xml,server})=>{
            const {diagramData,diagramXML}=await import(module);
            return {browser:diagramXML(diagramData(xml)),server:diagramXML(server),data:diagramData(xml)};
        }''', {'module':module,'xml':XML,'server':diagram_data(XML)})
        expected = element_data(diagram_parse(XML))
        assert element_data(diagram_parse(result['browser'])) == expected
        assert element_data(diagram_parse(result['server'])) == expected
        assert element_data(diagram_parse(diagram_xml(result['data']))) == expected
        bare='<mxGraphModel xmlns:e="urn:ext" e:custom="kept"><e:metadata>mixed<e:child/>tail</e:metadata><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>'
        captured='<mxfile><diagram id="generated" name="Page"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>'
        preserved=page.evaluate('''async ({module,bare,captured})=>{const {diagramData,diagramXML}=await import(module);return diagramXML(diagramData(captured,{previous:diagramData(bare)}));}''',{'module':module,'bare':bare,'captured':captured})
        assert element_data(diagram_parse(preserved)) == element_data(diagram_parse(bare))
        browser.close()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('kind',['canvas','drawio'])
def test_graph_presence_selection_and_disconnect(realtime_server,workspace,kind):
    from tests.browser.test_visual import login
    from wiki.services import save_document
    contents={'canvas':json.dumps({'nodes':[{'id':'n','type':'text','text':'Canvas card','x':0,'y':0,'width':200,'height':100}],'edges':[]}),
        'drawio':'<mxfile><diagram id="p" name="Page"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="n" vertex="1" parent="1" value="Diagram card"><mxGeometry x="10" y="10" width="200" height="100" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>'}
    doc=save_document(workspace['admin'],'Presence '+kind,kind,'Notes',contents[kind],workspace['team'])
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        a,b=browser.new_page(),browser.new_page();messages=[];errors=[]
        def received(frame):
            message=json.loads(frame)
            if message.get('type')=='presence':messages.extend(message['sessions'])
        a.on('websocket',lambda socket:socket.on('framereceived',received))
        for page,user in [(a,'admin'),(b,'member')]:
            page.on('pageerror',lambda error:errors.append(str(error)))
            login(page,realtime_server,user);page.goto(realtime_server+f'/documents/{doc.pk}/live/')
        if kind=='canvas':
            expect(a.locator('[data-node-id="n"]')).to_be_visible()
            expect(b.locator('[data-node-id="n"]')).to_be_visible()
            b.locator('[data-node-id="n"]').click(position={'x':40,'y':40})
            remote=a.locator('.remote-presence-selection');cursor=a.locator('.remote-presence-cursor')
            expected='n'
        else:
            for page in [a,b]:
                expect(page.frame_locator('.drawio-frame').locator('.geDiagramContainer')).to_contain_text('Diagram card',timeout=45000)
            b.evaluate("()=>{const g=document.querySelector('iframe').contentWindow.yourwikiEditor.editor.graph;g.setSelectionCell(g.model.getCell('n'));}")
            remote=a.frame_locator('.drawio-frame').locator('.remote-presence-selection');cursor=a.frame_locator('.drawio-frame').locator('.remote-presence-cursor')
            expected='["p","n"]'
        expect(remote).to_have_count(1,timeout=15000)
        expect(cursor).to_have_count(1,timeout=15000)
        assert any(expected in entry.get('selection',{}).get('node_ids',[]) for entry in messages)
        b.close();expect(remote).to_have_count(0,timeout=15000);expect(cursor).to_have_count(0,timeout=15000)
        assert not errors,errors
        browser.close()


@pytest.mark.django_db(transaction=True)
def test_two_canvas_drags_add_and_pointer_cancel_recovers(realtime_server, workspace):
    from tests.browser.test_visual import login
    from wiki.services import save_document
    doc = save_document(workspace['admin'], 'Concurrent canvas', 'canvas', 'Notes', json.dumps({'nodes':[
        {'id':'n','type':'text','text':'Move together','x':0,'y':0,'width':200,'height':100},
        {'id':'m','type':'text','text':'Move selection','x':300,'y':0,'width':200,'height':100}], 'edges':[]}),workspace['team'])
    doc.inherit_permissions=False;doc.policy['group']['write']=True;doc.save()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        pages = [browser.new_page(),browser.new_page()]
        errors=[]
        for page,user in zip(pages,['admin','member']):
            page.on('pageerror',lambda error:errors.append(str(error)))
            login(page,realtime_server,user)
            page.goto(realtime_server+f'/documents/{doc.pk}/live/')
            expect(page.locator('[data-node-id="n"]')).to_be_visible()
        for page in pages:
            card=page.locator('[data-node-id="n"]');rect=bounds(card)
            page.mouse.move(rect['x']+40,rect['y']+40);page.mouse.down()
        for page in pages:
            card=page.locator('[data-node-id="n"]');rect=bounds(card)
            scale=page.locator('.canvas-world').evaluate('el=>new DOMMatrix(getComputedStyle(el).transform).a')
            page.mouse.move(rect['x']+40+30*scale,rect['y']+40)
        for page in pages:page.mouse.up()
        deadline=time.monotonic()+12
        while time.monotonic()<deadline:
            saved=pages[0].request.get(realtime_server+f'/api/docs/{doc.pk}').json()
            if abs(next(node for node in json.loads(saved['content'])['nodes'] if node['id']=='n')['x']-60)<.1:break
            time.sleep(.1)
        assert abs(next(node for node in json.loads(saved['content'])['nodes'] if node['id']=='n')['x']-60)<.1
        page=pages[0];card=page.locator('[data-node-id="n"]');rect=bounds(card)
        page.mouse.move(rect['x']+40,rect['y']+40);page.mouse.down()
        page.mouse.move(rect['x']+100,rect['y']+40)
        card.dispatch_event('pointercancel',{'pointerId':1,'clientX':rect['x']+100,'clientY':rect['y']+40})
        page.mouse.up()
        expect(page.locator('[data-node-id="n"]')).to_have_css('left','60px')
        page.locator('[data-node-id="m"]').click(modifiers=['Shift'],position={'x':40,'y':40})
        rect=bounds(page.locator('[data-node-id="n"]'))
        scale=page.locator('.canvas-world').evaluate('el=>new DOMMatrix(getComputedStyle(el).transform).a')
        page.mouse.move(rect['x']+40,rect['y']+40);page.mouse.down();page.mouse.move(rect['x']+40+20*scale,rect['y']+40)
        expect(page.locator('[data-node-id="n"]')).to_have_css('left','80px')
        expect(page.locator('[data-node-id="m"]')).to_have_css('left','320px')
        page.locator('[data-node-id="n"]').dispatch_event('pointercancel',{'pointerId':1})
        page.mouse.up()
        expect(page.locator('[data-node-id="m"]')).to_have_css('left','300px')
        assert not errors,errors
        browser.close()
