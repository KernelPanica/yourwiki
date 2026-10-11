import json
import pytest
from django.urls import reverse
from wiki.models import SiteConfiguration
from wiki.services import save_document
from wiki.storage import active_storage

pytestmark = pytest.mark.django_db


def versions(workspace, document):
    SiteConfiguration.objects.update_or_create(pk=1, defaults={'revision_history': True})
    previous = active_storage().read(document.reference)
    updated = save_document(workspace['admin'], document.title, document.kind, document.collection, 'New version', document.group, document, document.revision)
    return updated, previous


def restore_payload(doc, client):
    rows = client.get(reverse('file-versions', args=[doc.pk])).json()['versions']
    row = rows[0]
    return row, {'revision': doc.revision, 'sha256': row['sha256']}


def test_version_list_preview_download_and_restore_preserves_bytes_and_identity(client, workspace, document):
    doc, original = versions(workspace, document)
    current = active_storage().read(doc.reference)
    reference, owner, policy = doc.reference, doc.owner_id, doc.policy
    client.force_login(workspace['admin'])
    row, payload = restore_payload(doc, client)
    assert 'content_base64' not in json.dumps(row)
    assert client.get(row['download_url']).content == original
    preview = client.get(row['view_url'])
    assert preview.status_code == 200
    assert 'Восстановить эту версию'.encode() in preview.content
    assert client.get(reverse('document', args=[doc.pk])).status_code == 200
    assert client.post(row['restore_url'], payload).status_code == 302
    doc.refresh_from_db()
    assert (doc.reference, doc.owner_id, doc.policy) == (reference, owner, policy)
    assert active_storage().read(doc.reference) == original
    history = json.loads(active_storage().read(doc.history_reference))
    import base64
    assert base64.b64decode(history['entries'][-1]['content_base64']) == current
    assert doc.revision == payload['revision'] + 1


def test_restore_rejects_stale_revision_and_external_change(client, workspace, document):
    doc, original = versions(workspace, document)
    client.force_login(workspace['admin'])
    row, payload = restore_payload(doc, client)
    assert client.post(row['restore_url'], {**payload, 'revision': doc.revision-1}).status_code == 409
    adapter = active_storage()
    adapter.write(__import__('wiki.services', fromlist=['storage_key']).storage_key(doc), b'External changed bytes', doc.reference)
    assert client.post(row['restore_url'], payload).status_code == 409
    assert adapter.read(doc.reference) == b'External changed bytes'


def test_restore_rejects_corrupted_snapshot(client, workspace, document):
    doc, original = versions(workspace, document)
    client.force_login(workspace['admin'])
    row, payload = restore_payload(doc, client)
    adapter = active_storage()
    history = json.loads(adapter.read(doc.history_reference))
    history['entries'][0]['content_base64'] = 'YWJj'
    from wiki.services import storage_key
    adapter.write(storage_key(doc)+'.json', json.dumps(history).encode(), doc.history_reference, limit=None)
    assert client.post(row['restore_url'], payload).status_code == 400
    assert adapter.read(doc.reference) != original


def test_read_only_user_can_view_but_cannot_restore(client, workspace, document):
    doc, _ = versions(workspace, document)
    doc.inherit_permissions = False
    doc.policy = {'owner': {'read': True, 'write': True}, 'group': {'read': True, 'write': False}, 'other': {'read': False, 'write': False}}
    doc.save()
    client.force_login(workspace['member'])
    row, payload = restore_payload(doc, client)
    response = client.get(row['view_url'])
    assert response.status_code == 200
    assert 'Восстановить эту версию'.encode() not in response.content
    assert client.post(row['restore_url'], payload).status_code in (403, 500)


def test_versions_available_when_history_disabled(client, workspace, document):
    doc, original = versions(workspace, document)
    SiteConfiguration.objects.filter(pk=1).update(revision_history=False)
    client.force_login(workspace['admin'])
    row, payload = restore_payload(doc, client)
    old_history = active_storage().read(doc.history_reference)
    assert client.post(row['restore_url'], payload).status_code == 302
    doc.refresh_from_db()
    assert active_storage().read(doc.reference) == original
    assert active_storage().read(doc.history_reference) == old_history


def test_restoration_is_post_only_and_exclusive_source_blocks(client, workspace, document):
    doc, _ = versions(workspace, document)
    client.force_login(workspace['admin'])
    row, payload = restore_payload(doc, client)
    assert client.get(row['restore_url']).status_code == 405
    from wiki.source import acquire
    acquire(doc, workspace['admin'])
    assert client.post(row['restore_url'], payload).status_code == 409


def test_pdf_version_inline_is_allowed_in_same_origin_preview(client,workspace):
    from wiki.services import save_document
    from tests.test_pdf_ai import sample_pdf
    SiteConfiguration.objects.update_or_create(pk=1,defaults={'revision_history':True})
    raw=sample_pdf()
    doc=save_document(workspace['admin'],'Version.pdf','file','Notes',raw,workspace['team'])
    # A byte-different PDF is sufficient to exercise stored binary history.
    doc=save_document(workspace['admin'],doc.title,'file','Notes',raw+b'\n',doc.group,doc,doc.revision)
    client.force_login(workspace['admin'])
    row,payload=restore_payload(doc,client)
    response=client.get(row['download_url']+'?inline=1')
    assert response.status_code==200
    assert response['Content-Type']=='application/pdf'
    assert response['X-Frame-Options']=='SAMEORIGIN'
    assert 'inline' in response['Content-Disposition']


def test_uploaded_docx_file_version_has_visual_preview(client,workspace):
    from io import BytesIO
    from docx import Document as Word
    def binary(text):
        doc=Word();doc.add_paragraph(text);stream=BytesIO();doc.save(stream);return stream.getvalue()
    SiteConfiguration.objects.update_or_create(pk=1,defaults={'revision_history':True})
    raw=binary('Uploaded original paragraph')
    doc=save_document(workspace['admin'],'Upload.docx','file','Notes',raw,workspace['team'])
    doc=save_document(workspace['admin'],doc.title,'file','Notes',binary('Uploaded updated paragraph'),doc.group,doc,doc.revision)
    client.force_login(workspace['admin'])
    row,payload=restore_payload(doc,client)
    response=client.get(row['view_url'])
    assert response.status_code==200
    assert b'Uploaded original paragraph' in response.content
    assert client.post(row['restore_url'],payload).status_code==302
    doc.refresh_from_db()
    assert active_storage().read(doc.reference)==raw


def test_canvas_version_download_retains_obsidian_extension(client,workspace):
    SiteConfiguration.objects.update_or_create(pk=1,defaults={'revision_history':True})
    initial=json.dumps({'nodes':[],'edges':[]})
    doc=save_document(workspace['admin'],'Board','canvas','Notes',initial,workspace['team'])
    updated=json.dumps({'nodes':[{'id':'a','type':'text','text':'New','x':0,'y':0,'width':200,'height':100}],'edges':[]})
    doc=save_document(workspace['admin'],doc.title,'canvas','Notes',updated,doc.group,doc,doc.revision)
    client.force_login(workspace['admin'])
    row,payload=restore_payload(doc,client)
    assert 'Board.canvas' in client.get(row['download_url'])['Content-Disposition']
