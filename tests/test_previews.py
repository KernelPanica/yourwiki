import base64
import json
import zlib
from urllib.parse import quote
import pytest
from wiki.previews import preview
from wiki.services import validate_content
from django.core.exceptions import ValidationError

def test_markdown_escapes_html_and_removes_unsafe_links():
    result=preview('document','<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n[safe](https://example.org)')['markdown']
    assert '<script>' not in result
    assert 'href="javascript:' not in result
    assert 'href="https://example.org"' in result

def test_compressed_drawio():
    xml='<mxGraphModel><root><mxCell id="1" vertex="1" value="hello"><mxGeometry x="5" y="10" width="100" height="50"/></mxCell></root></mxGraphModel>'
    compressor=zlib.compressobj(wbits=-15)
    data=compressor.compress(quote(xml).encode())+compressor.flush()
    result=preview('drawio','<mxfile><diagram>'+base64.b64encode(data).decode()+'</diagram></mxfile>')
    assert result['nodes'][0]['label']=='hello'

def test_bad_geometry_and_xml_entities():
    with pytest.raises(ValueError):
        preview('canvas',json.dumps({'nodes':[{'id':'1','x':'injection','y':0,'width':10,'height':10}]}))
    with pytest.raises(ValidationError):
        validate_content('drawio','<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>')


def test_drawio_grouped_wrapped_cells_preview_after_saved_roundtrip():
    from wiki.collaboration import diagram_data, diagram_xml
    xml = '''<mxfile><diagram id="p"><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <object id="card" label="Saved label"><mxCell vertex="1" parent="group" style="fillColor=#aabbcc">
        <mxGeometry x="20" y="30" width="100" height="50"/>
      </mxCell></object>
      <mxCell id="group" vertex="1" parent="1"><mxGeometry x="500" y="600" width="300" height="200"/></mxCell>
      <mxCell id="edge" edge="1" source="group" target="card" value="&lt;b&gt;Link&lt;/b&gt;"/>
    </root></mxGraphModel></diagram></mxfile>'''
    result = preview('drawio', diagram_xml(diagram_data(xml)))
    assert [node['id'] for node in result['nodes']] == ['group', 'card']
    card = result['nodes'][1]
    assert (card['x'], card['y'], card['label'], card['color']) == (520, 630, 'Saved label', '#aabbcc')
    assert result['edges'][0]['label'] == 'Link'


def test_canvas_preview_preserves_custom_color_and_multiline_text():
    result = preview('canvas', json.dumps({'nodes':[
        {'id':'a','text':'First\nSecond','color':'#aabbcc','x':-5000,'y':9000,'width':200,'height':100}
    ], 'edges':[]}))
    assert result['nodes'][0]['label'] == 'First\nSecond'
    assert result['nodes'][0]['color'] == '#aabbcc'


def test_canvas_group_background_is_behind_saved_cards():
    result = preview('canvas', json.dumps({'nodes':[
        {'id':'card','type':'text','text':'Visible','x':20,'y':20,'width':100,'height':100},
        {'id':'group','type':'group','label':'Group','x':0,'y':0,'width':300,'height':300}
    ], 'edges':[]}))
    assert [node['id'] for node in result['nodes']] == ['group', 'card']

pytestmark = pytest.mark.django_db


def test_canvas_preview_obeys_obsidian_edge_sides_and_ends():
    result = preview('canvas', json.dumps({'nodes':[
        {'id':'a','type':'text','x':0,'y':0,'width':100,'height':100},
        {'id':'b','type':'text','x':300,'y':0,'width':100,'height':100},
    ], 'edges':[{'id':'e','fromNode':'a','toNode':'b','fromSide':'right','toSide':'left','fromEnd':'arrow','toEnd':'none'}]}))
    assert result['edges'][0]['path'] == 'M100,50.0 C160,50.0 240,50.0 300,50.0'
    assert result['edges'][0]['from_arrow'] is True
    assert result['edges'][0]['to_arrow'] is False
