import asyncio
import json
import uuid

import pytest
from asgiref.testing import ApplicationCommunicator

pytestmark = pytest.mark.django_db(transaction=True)


def test_readonly_presence_broadcast_and_disconnect(document, workspace, monkeypatch):
    from wiki import realtime
    from wiki.collaboration import ensure_room
    from wiki.presence_models import PresenceSession
    ensure_room(document)
    monkeypatch.setattr(realtime, 'authenticate', lambda *args: (workspace['member'], False))
    session_id = str(uuid.uuid4())

    async def scenario():
        channel = ApplicationCommunicator(realtime.application, {'type': 'websocket', 'path': f'/ws/documents/{document.pk}/'})
        await channel.send_input({'type': 'websocket.connect'})
        assert (await channel.receive_output(timeout=5))['type'] == 'websocket.accept'
        await channel.send_input({'type': 'websocket.receive', 'text': json.dumps({
            'type': 'presence', 'session_id': session_id,
            'selection': {'kind': 'text', 'anchor': 'a', 'head': 'b'}})})
        found = None
        for _ in range(6):
            message = json.loads((await channel.receive_output(timeout=5))['text'])
            if message['type'] == 'presence' and message['sessions']:
                found = message['sessions'][0]
                break
        assert found and found['id'] == session_id and found['name'] == 'Member'
        await channel.send_input({'type': 'websocket.disconnect'})
        await channel.wait(timeout=5)

    asyncio.run(scenario())
    assert not PresenceSession.objects.filter(pk=session_id).exists()


def test_invalid_presence_does_not_change_crdt(document, workspace, monkeypatch):
    from wiki import realtime
    from wiki.collaboration import ensure_room
    from wiki.presence_models import PresenceSession
    room = ensure_room(document)
    before = bytes(room.state)
    monkeypatch.setattr(realtime, 'authenticate', lambda *args: (workspace['member'], False))

    async def scenario():
        channel = ApplicationCommunicator(realtime.application, {'type': 'websocket', 'path': f'/ws/documents/{document.pk}/'})
        await channel.send_input({'type': 'websocket.connect'})
        await channel.receive_output(timeout=5)
        await channel.send_input({'type': 'websocket.receive', 'text': json.dumps({
            'type': 'presence', 'session_id': str(uuid.uuid4()), 'selection': {'kind': 'invalid'}})})
        for _ in range(6):
            message = json.loads((await channel.receive_output(timeout=5))['text'])
            if message['type'] == 'presence-error':
                break
        else:
            pytest.fail('Invalid presence must receive an error')
        await channel.send_input({'type': 'websocket.disconnect'})
        await channel.wait(timeout=5)

    asyncio.run(scenario())
    room.refresh_from_db()
    assert bytes(room.state) == before
    assert not PresenceSession.objects.filter(document=document).exists()


def test_disconnect_does_not_retry_unknown_write(document, workspace, monkeypatch):
    from unittest.mock import Mock
    from wiki import realtime
    from wiki.collaboration import ensure_room
    from wiki.models import SaveSession
    ensure_room(document)
    SaveSession.objects.create(document=document, author=workspace['admin'], client_id='collaboration',
        base_revision=document.revision, base_etag=document.storage_digest, payload=b'pending',
        payload_hash='pending', state='unknown')
    monkeypatch.setattr(realtime, 'authenticate', lambda *args: (workspace['admin'], True))
    flush = Mock()
    monkeypatch.setattr(realtime, 'flush_room', flush)

    async def scenario():
        channel = ApplicationCommunicator(realtime.application, {'type': 'websocket', 'path': f'/ws/documents/{document.pk}/'})
        await channel.send_input({'type': 'websocket.connect'})
        await channel.receive_output(timeout=5)
        await channel.send_input({'type': 'websocket.disconnect'})
        await channel.wait(timeout=5)

    asyncio.run(scenario())
    flush.assert_not_called()
