import pytest
from wiki.collaboration import ensure_room, apply_update
from wiki.external_sync import refresh
from wiki.models import SaveSession
from tests.test_collaboration import edit_state

pytestmark = pytest.mark.django_db


def test_external_change_replaces_clean_room_and_rejects_old_generation(workspace, document):
    room = ensure_room(document)
    generation = str(room.generation)
    update = edit_state(room, 'Old client ')
    from wiki.storage import active_storage
    active_storage().write('ignored.md', b'Remote revision', document.reference)
    assert refresh(document.pk, force=True)
    room.refresh_from_db()
    assert str(room.generation) != generation
    assert 'Remote revision' in room.snapshot
    assert room.sequence == room.synced_sequence
    from wiki.services import Conflict
    with pytest.raises(Conflict):
        apply_update(workspace['admin'], document.pk, update, generation=generation)
    assert not refresh(document.pk, force=True)


def test_external_change_preserves_pending_local_edits(workspace, document):
    room = ensure_room(document)
    apply_update(workspace['admin'], document.pk, edit_state(room, 'Local edit '))
    from wiki.storage import active_storage
    active_storage().write('ignored.md', b'Remote edit', document.reference)
    before = bytes(type(room).objects.get(pk=room.pk).state)
    assert not refresh(document.pk, force=True)
    room.refresh_from_db()
    assert bytes(room.state) == before
    assert 'Local edit' in room.snapshot
    assert SaveSession.objects.get(document=document, client_id='collaboration').state == 'conflict'
    assert active_storage().read(document.reference) == b'Remote edit'


def test_provider_failure_leaves_room_unchanged(workspace, document):
    room = ensure_room(document)
    from unittest.mock import patch
    from wiki.storage import StorageError
    with patch('wiki.external_sync.active_storage') as adapter:
        adapter.return_value.read.side_effect = StorageError('Offline')
        with pytest.raises(StorageError):
            refresh(document.pk, force=True)
    room.refresh_from_db()
    assert room.sequence == 0


def test_storage_heartbeat_enforces_read_access(client, workspace, document):
    url = f'/api/docs/{document.pk}/storage-status'
    client.force_login(workspace['outsider'])
    assert client.get(url).status_code in (403, 404)
    client.force_login(workspace['admin'])
    response = client.get(url)
    assert response.status_code == 200
    assert response.json()['interval'] == 30


@pytest.mark.parametrize('file_format', ['docx', 'ods'])
def test_portable_external_files_refresh_editor_state(workspace, file_format):
    import io
    from wiki.services import save_document
    from wiki.storage import active_storage
    kind = 'document' if file_format == 'docx' else 'table'
    doc = save_document(workspace['admin'], 'Portable', kind, 'Notes', 'Initial', workspace['team'], file_format=file_format)
    room = ensure_room(doc)
    if file_format == 'docx':
        from docx import Document
        external = Document(); external.add_paragraph('Edited outside Yourwiki')
        output = io.BytesIO(); external.save(output); raw = output.getvalue()
    else:
        from wiki.file_formats import encode
        raw = encode(doc, 'Edited outside Yourwiki,42')
    active_storage().write('ignored.' + file_format, raw, doc.reference)
    assert refresh(doc.pk, force=True)
    room.refresh_from_db()
    assert 'Edited outside Yourwiki' in room.snapshot


def test_unknown_write_is_not_replaced_by_remote_scan(workspace, document):
    room = ensure_room(document)
    apply_update(workspace['admin'], document.pk, edit_state(room, 'Uncertain edit '))
    session = SaveSession.objects.get(document=document, client_id='collaboration')
    session.state = 'unknown'; session.save()
    from wiki.storage import active_storage
    active_storage().write('ignored.md', b'Unknown remote outcome', document.reference)
    assert not refresh(document.pk, force=True)
    session.refresh_from_db()
    assert session.state == 'unknown'


def test_http_flush_checks_generation_and_returns_save_confirmation(client, workspace, document):
    room = ensure_room(document)
    client.force_login(workspace['admin'])
    url = f'/api/docs/{document.pk}/flush'
    update = edit_state(room, 'HTTP edit ')
    assert client.post(url, {'update':update}, content_type='application/json').status_code == 409
    response = client.post(url, {'update':update, 'generation':str(room.generation)}, content_type='application/json')
    assert response.status_code == 200
    assert response.json()['sequence'] == response.json()['synced_sequence']
    assert response.json()['save_state'] == 'saved'
