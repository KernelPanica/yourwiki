import base64
import pytest
from unittest.mock import Mock
from pycrdt import Doc, XmlFragment
from wiki.collaboration import ensure_room, apply_update, flush_room
from wiki.services import Conflict
from wiki.storage import active_storage


def edit(room,text):
    y=Doc();y.apply_update(bytes(room.state));y.get('content',type=XmlFragment).children[0].children[0].insert(0,text)
    return base64.b64encode(y.get_update()).decode()


def test_collaborative_conflict_is_durable_and_never_retried(document,workspace,monkeypatch):
    from wiki.models import SaveSession
    room=ensure_room(document)
    apply_update(workspace['admin'],document.pk,edit(room,'Local changes '))
    storage=active_storage();storage.write('ignored',b'External original',document.reference)
    with pytest.raises(Conflict):flush_room(document.pk)
    session=SaveSession.objects.get(document=document,client_id='collaboration')
    assert session.state=='conflict' and b'Local changes' in bytes(session.payload)
    adapter=Mock();monkeypatch.setattr('wiki.collaboration.active_storage',lambda:adapter)
    with pytest.raises(Conflict):flush_room(document.pk)
    adapter.write.assert_not_called();adapter.read.assert_not_called()
    assert storage.read(document.reference)==b'External original'


def test_pending_save_rechecks_writer_access(document,workspace):
    from wiki.models import SaveSession
    from django.core.exceptions import PermissionDenied
    document.policy['group']['write']=True;document.save()
    room=ensure_room(document);apply_update(workspace['member'],document.pk,edit(room,'Member '))
    document.policy['group']['write']=False;document.save()
    before=active_storage().read(document.reference)
    with pytest.raises(PermissionDenied):flush_room(document.pk)
    assert active_storage().read(document.reference)==before
    assert SaveSession.objects.get(document=document,client_id='collaboration').state=='denied'


def test_provider_failure_keeps_payload_and_can_retry(document,workspace,monkeypatch):
    from wiki.models import SaveSession
    room=ensure_room(document);apply_update(workspace['admin'],document.pk,edit(room,'Durable '))
    adapter=active_storage();broken=Mock(wraps=adapter);broken.write.side_effect=OSError('token-secret')
    monkeypatch.setattr('wiki.collaboration.active_storage',lambda:broken)
    from wiki.write_journal import WriteUncertain
    with pytest.raises(WriteUncertain):flush_room(document.pk)
    session=SaveSession.objects.get(document=document,client_id='collaboration')
    assert session.state=='unknown' and 'token-secret' not in session.error and session.payload
    monkeypatch.setattr('wiki.collaboration.active_storage',lambda:adapter)
    flush_room(document.pk);session.refresh_from_db()
    assert session.state=='saved' and not session.payload

def test_http_flush_and_explicit_recovery(client,document,workspace):
    from wiki.models import Document, SaveSession
    client.force_login(workspace['admin'])
    room=ensure_room(document);update=edit(room,'Recover this ')
    storage=active_storage();storage.write('ignored',b'Changed elsewhere',document.reference)
    url=f'/api/docs/{document.pk}'
    assert client.post(url+'/flush',{'update':update,'generation':str(room.generation)},content_type='application/json').status_code==409
    assert client.get(url+'/status').json()['save_state']=='conflict'
    copied=client.post(url+'/recover',{'action':'copy','title':'Recovered copy','update':update},content_type='application/json')
    assert copied.status_code==201
    copy=Document.objects.get(title='Recovered copy')
    from wiki.collaboration import current_content
    assert 'Recover this' in current_content(copy)
    assert storage.read(document.reference)==b'Changed elsewhere'
    assert client.post(url+'/recover',{'action':'reload'},content_type='application/json').status_code==400
    assert client.post(url+'/recover',{'action':'reload','discard':True},content_type='application/json').status_code==200
    assert not SaveSession.objects.filter(document=document).exists()
    assert 'Changed elsewhere' in ensure_room(document).snapshot


def test_pdf_stale_sessions_do_not_overwrite_and_retry_is_idempotent(workspace,client):
    from tests.test_pdf_ai import sample_pdf
    from wiki.services import save_document
    from django.core.files.uploadedfile import SimpleUploadedFile
    from wiki.models import SaveSession
    raw=sample_pdf();doc=save_document(workspace['admin'],'Test.pdf','file','Files',raw,workspace['team'])
    client.force_login(workspace['admin']);url=f'/documents/{doc.pk}/pdf/'
    data=lambda cid:{'client_id':cid,'revision':1,'file':SimpleUploadedFile('edited.pdf',raw)}
    assert client.post(url,data('tab-a')).status_code==200
    assert client.post(url,data('tab-a')).status_code==200
    doc.refresh_from_db();assert doc.revision==2
    assert client.post(url,data('tab-b')).status_code==409
    conflict=SaveSession.objects.get(document=doc,client_id=f'pdf:{workspace["admin"].pk}:tab-b')
    assert conflict.state=='conflict' and bytes(conflict.payload)==raw

def test_pdf_open_records_legacy_baseline_and_detects_external_change(client,workspace):
    from tests.test_pdf_ai import sample_pdf
    from wiki.services import save_document
    from wiki.models import Document
    raw=sample_pdf();doc=save_document(workspace['admin'],'Legacy.pdf','file','Files',raw,workspace['team'])
    Document.objects.filter(pk=doc.pk).update(storage_digest='')
    client.force_login(workspace['admin'])
    assert client.get(f'/documents/{doc.pk}/').status_code==200
    doc.refresh_from_db();assert doc.storage_digest
    active_storage().write('ignored',raw+b'\n% changed',doc.reference)
    assert client.get(f'/documents/{doc.pk}/').status_code==200
    doc.refresh_from_db();assert doc.revision==2

def test_pdf_retry_does_not_acknowledge_another_tabs_revision(client,workspace):
    from tests.test_pdf_ai import sample_pdf
    from wiki.services import save_document
    from django.core.files.uploadedfile import SimpleUploadedFile
    raw=sample_pdf();doc=save_document(workspace['admin'],'Retry.pdf','file','Files',raw,workspace['team'])
    client.force_login(workspace['admin']);url=f'/documents/{doc.pk}/pdf/'
    def save(cid,revision,body):return client.post(url,{'client_id':cid,'revision':revision,'file':SimpleUploadedFile('edited.pdf',body)})
    assert save('A',1,raw).json()['revision']==2
    assert save('B',2,raw+b'\n%B').json()['revision']==3
    assert save('A',1,raw).json()['revision']==2
    assert save('A',2,raw+b'\n%A later edit').status_code==409
    assert active_storage().read(doc.reference)==raw
    from wiki.pdf_layers import saved_pdf
    assert saved_pdf(doc)==raw+b'\n%B'

def test_offline_snapshot_round_trip(client,document,workspace):
    import json
    from django.core.files.uploadedfile import SimpleUploadedFile
    from wiki.models import Document
    from wiki.collaboration import current_content
    room=ensure_room(document);state=edit(room,'Offline unsent ')
    snapshot={'format':'yourwiki-recovery','version':1,'kind':'document','file_format':'md','state':state}
    client.force_login(workspace['admin'])
    response=client.post('/documents/import/',{'file':SimpleUploadedFile('Draft.recovery.json',json.dumps(snapshot).encode())})
    assert response.status_code==302
    restored=Document.objects.get(title='Draft (recovered)')
    assert restored.file_format=='md' and 'Offline unsent' in current_content(restored)
    assert 'Offline unsent' not in current_content(document)

def test_legacy_room_is_written_as_markdown_not_json(document,workspace):
    document.file_format='';document.save(update_fields=['file_format'])
    room=ensure_room(document);apply_update(workspace['admin'],document.pk,edit(room,'Legacy edit '))
    flush_room(document.pk);document.refresh_from_db()
    assert document.file_format=='md'
    assert active_storage().read(document.reference).startswith(b'---\n')
