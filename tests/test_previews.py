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
