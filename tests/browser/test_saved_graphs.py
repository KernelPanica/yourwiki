"""Saved diagrams render at their real positions; distant Canvas cards open in view."""
import json
import os
import pytest
from playwright.sync_api import expect, sync_playwright
from wiki.services import save_document
from wiki.collaboration import ensure_room, flush_room

pytestmark = [pytest.mark.browser, pytest.mark.django_db(transaction=True),
              pytest.mark.skipif(os.environ.get('RUN_BROWSER') != '1', reason='Set RUN_BROWSER=1')]


def test_saved_canvas_and_drawio_display(realtime_server, workspace):
    canvas = save_document(workspace['admin'], 'Saved canvas', 'canvas', 'Tests', json.dumps({
        'nodes':[{'id':'a','type':'text','text':'Far away\nSaved card','color':'#aabbcc',
                  'x':-5000,'y':9000,'width':240,'height':140}], 'edges':[]}), workspace['team'])
    drawio = save_document(workspace['admin'], 'Saved diagram', 'drawio', 'Tests', '''
        <mxfile><diagram id="p"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
        <object id="a" label="Saved diagram card"><mxCell vertex="1" parent="group" style="ellipse;fillColor=#ffcc00;"><mxGeometry as="geometry" x="20" y="30" width="200" height="80"/></mxCell></object>
        <mxCell id="group" vertex="1" parent="1"><mxGeometry as="geometry" x="500" y="600" width="300" height="200"/></mxCell>
        <mxCell id="arrow" edge="1" parent="1" source="a" target="group" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;"><mxGeometry as="geometry" relative="1"/></mxCell>
        </root></mxGraphModel></diagram><diagram id="second" name="Second page"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="b" value="Second page content" vertex="1" parent="1" style="rhombus;fillColor=#00ccff;"><mxGeometry as="geometry" x="10" y="10" width="200" height="100"/></mxCell></root></mxGraphModel></diagram></mxfile>''', workspace['team'])
    for doc in [canvas, drawio]:
        room = ensure_room(doc); room.sequence += 1; room.save(); flush_room(doc.pk)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
        page = browser.new_page(viewport={'width':1280,'height':900})
        page.goto(realtime_server + '/login/')
        page.get_by_label('Username').fill('admin')
        page.get_by_label('Password', exact=True).fill('Correct-password-8923')
        page.get_by_role('button', name='Sign in', exact=True).click()
        for doc, label in [(canvas,'Far away\nSaved card'), (drawio,'Saved diagram card')]:
            page.goto(realtime_server + f'/documents/{doc.pk}/')
            if doc.kind == 'drawio':
                frame = page.frame_locator('#drawio-preview')
                expect(frame.locator('#diagram')).to_contain_text(label, timeout=20000)
                page.screenshot(path='/tmp/yourwiki-drawio-preview.png', full_page=True)
                expect(frame.locator('[fill="#ffcc00"]').first).to_be_visible()
                expect(page.locator('#drawio-preview-status')).to_be_hidden()
                frame.locator('[title="Next Page"]').click()
                expect(frame.locator('#diagram')).to_contain_text('Second page content')
                expect(frame.locator('[fill="#00ccff"]').first).to_be_visible()
                frame.locator('[title="Previous Page"]').click()
                expect(frame.locator('#diagram')).to_contain_text(label)
                page.screenshot(path='/tmp/yourwiki-drawio-preview.png', full_page=True)
            else:
                expect(page.locator('.node-label').filter(has_text=label)).to_be_visible()
                assert page.locator('.graph').evaluate('e => e.getBBox().width > 0')
        page.goto(realtime_server + f'/documents/{canvas.pk}/live/')
        expect(page.locator('.canvas-node')).to_contain_text('Saved card')
        page.wait_for_function('''() => {
          const card=document.querySelector('.canvas-node')?.getBoundingClientRect();
          const stage=document.querySelector('.canvas-stage')?.getBoundingClientRect();
          return card && stage && card.left>=stage.left && card.right<=stage.right && card.top>=stage.top && card.bottom<=stage.bottom;
        }''')
        page.reload()
        expect(page.locator('.canvas-node')).to_contain_text('Saved card')
        expect(page.locator('#editor-error')).to_be_hidden()
        browser.close()
