import base64
import json
from unittest.mock import patch
import pytest
from pycrdt import Doc, Map, XmlFragment
from django.core.exceptions import PermissionDenied
from wiki.collaboration import ensure_room, apply_update, flush_room, derive, current_content
from wiki.models import Collaboration, Review
from wiki.native import unpack
from wiki.services import save_document, Conflict

pytestmark = pytest.mark.django_db


def edit_state(room, text):
    ydoc=Doc(); ydoc.apply_update(bytes(room.state))
    fragment=ydoc.get('content',type=XmlFragment)
    paragraph=next(n for n in fragment.children if n.tag=='paragraph')
    paragraph.children[0].insert(0,text)
    return base64.b64encode(ydoc.get_update()).decode()


def test_concurrent_text_merges_and_retry_is_idempotent(workspace,document):
    room=ensure_room(document)
    a,b=edit_state(room,'Alice '),edit_state(room,'Bob ')
    apply_update(workspace['admin'],document.pk,a)
    sequence=apply_update(workspace['admin'],document.pk,b)
    room.refresh_from_db()
    assert 'Alice ' in room.snapshot and 'Bob ' in room.snapshot
    assert apply_update(workspace['admin'],document.pk,b)==sequence
    reopened=Doc();reopened.apply_update(bytes(room.state))
    assert derive(reopened,'document')==room.snapshot


def test_storage_failure_does_not_lose_acknowledged_edits(workspace,document):
    room=ensure_room(document)
    apply_update(workspace['admin'],document.pk,edit_state(room,'Durable '))
    old=document.reference
    with patch('wiki.collaboration.active_storage') as storage:
        storage.return_value.write.side_effect=OSError('offline')
        with pytest.raises(OSError):flush_room(document.pk)
    room.refresh_from_db();document.refresh_from_db()
    assert room.sequence>room.synced_sequence and document.reference==old
    assert 'Durable ' in current_content(document)
    flush_room(document.pk)
    room.refresh_from_db();document.refresh_from_db()
    assert room.sequence==room.synced_sequence and document.reference!=old


def test_reader_cannot_send_collaborative_updates(workspace,document):
    room=ensure_room(document)
    with pytest.raises(PermissionDenied):apply_update(workspace['member'],document.pk,edit_state(room,'Forbidden'))
    assert Collaboration.objects.get(document=document).sequence==0


def test_legacy_save_cannot_overwrite_collaboration(workspace,document):
    ensure_room(document)
    with pytest.raises(Conflict):save_document(workspace['admin'],document.title,document.kind,document.collection,'overwrite',document.group,document,1)


@pytest.mark.parametrize('kind,content',[
    ('table','Name,Value\nOne,2'),
    ('canvas',json.dumps({'nodes':[{'id':'n','type':'text','text':'A','x':0,'y':0,'width':200,'height':100,'custom':'keep'}],'edges':[],'custom':'keep'})),
    ('drawio','<mxfile><diagram id="p1" name="One"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" vertex="1" parent="1" value="A"><mxGeometry x="0" y="0" width="100" height="100"/></mxCell></root></mxGraphModel></diagram><diagram id="p2" name="Two"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>')])
def test_graph_and_table_roundtrip(workspace,kind,content):
    document=save_document(workspace['admin'],kind,kind,'test',content,workspace['team'])
    room=ensure_room(document);ydoc=Doc();ydoc.apply_update(bytes(room.state))
    value=derive(ydoc,kind)
    if kind=='table': assert unpack(value)['data']['sheets']['sheet1']['cellData']['1']['0']['v']=='One'
    elif kind=='canvas': assert json.loads(value)['nodes'][0]['custom']=='keep'
    else: assert 'p2' in value and 'value="A"' in value


def test_reviews_require_read_and_resolution_requires_write(client,workspace,document):
    client.force_login(workspace['member'])
    url=f'/api/docs/{document.pk}/reviews'
    response=client.post(url,json.dumps({'kind':'suggestion','body':'Better','anchor':{}}),content_type='application/json')
    assert response.status_code==200
    review_id=response.json()[0]['id']
    assert client.post(url+f'/{review_id}',json.dumps({'action':'reject'}),content_type='application/json').status_code==500
    client.force_login(workspace['admin'])
    assert client.post(url+f'/{review_id}',json.dumps({'action':'reject'}),content_type='application/json').status_code==200
    assert Review.objects.get(pk=review_id).status=='rejected'
    client.force_login(workspace['outsider'])
    assert client.get(url).status_code==500


def test_image_upload_is_sanitized_and_protected(client,workspace,document):
    from PIL import Image
    from io import BytesIO
    from django.core.files.uploadedfile import SimpleUploadedFile
    raw=BytesIO();Image.new('RGB',(10,10)).save(raw,'PNG')
    client.force_login(workspace['admin'])
    response=client.post(f'/api/docs/{document.pk}/attachments',{'file':SimpleUploadedFile('image.png',raw.getvalue())})
    assert response.status_code==201
    url=response.json()['url']
    assert client.get(url).status_code==200
    client.force_login(workspace['outsider'])
    assert client.get(url).status_code==500
    client.force_login(workspace['admin'])
    assert client.post(f'/api/docs/{document.pk}/attachments',{'file':SimpleUploadedFile('bad.svg',b'<svg/>')}).status_code==400


def test_native_preview_cannot_inject_script(client,workspace):
    from wiki.native import pack
    content=pack('document',{'type':'doc','content':[{'type':'paragraph','content':[{'type':'text','text':'<script>alert(1)</script>','marks':[{'type':'link','attrs':{'href':'javascript:alert(1)'}}]}]}]})
    doc=save_document(workspace['admin'],'safe','document','test',content,workspace['team'])
    client.force_login(workspace['admin'])
    response=client.get(f'/documents/{doc.pk}/')
    assert b'<script>alert(1)' not in response.content
    assert b'javascript:alert' not in response.content
