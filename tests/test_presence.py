from datetime import timedelta
import uuid

import pytest
from django.core.exceptions import PermissionDenied, ValidationError
from django.utils import timezone


def test_presence_readonly_heartbeat_reconnect_and_expiry(document, workspace):
    from wiki.presence import touch, list_active, expire, TTL_SECONDS
    from wiki.presence_models import PresenceSession
    sid = str(uuid.uuid4())
    selection = {'kind': 'text', 'anchor': 'stable-relative-anchor', 'head': 'stable-relative-head'}
    entry = touch(document.pk, workspace['member'], sid, selection)
    assert entry['id'] == sid and entry['name'] == 'Member'
    assert entry['selection'] == selection
    assert entry['color'].startswith('#') and len(entry['color']) == 7
    assert not document.allows(workspace['member'], 'write')
    prior = PresenceSession.objects.get(pk=sid)
    assert prior.expires_at - prior.heartbeat == timedelta(seconds=TTL_SECONDS)
    assert touch(document.pk, workspace['member'], sid, {})['color'] == entry['color']
    assert len(list_active(document.pk)) == 1
    assert list_active(document.pk)[0]['selection'] == {}
    PresenceSession.objects.filter(pk=sid).update(expires_at=timezone.now() - timedelta(seconds=1))
    assert list_active(document.pk) == []
    assert touch(document.pk, workspace['member'], sid, {})['id'] == sid
    assert PresenceSession.objects.filter(pk=sid).count() == 1
    assert expire(now=timezone.now() + timedelta(seconds=TTL_SECONDS + 1)) == 1
    assert list_active(document.pk) == []


def test_presence_binds_id_to_user_and_document(document, workspace):
    from wiki.presence import touch, remove
    from wiki.presence_models import PresenceSession
    sid = str(uuid.uuid4())
    touch(document.pk, workspace['member'], sid, {})
    with pytest.raises(PermissionDenied):
        touch(document.pk, workspace['admin'], sid, {})
    with pytest.raises(PermissionDenied):
        remove(document.pk, workspace['admin'], sid)
    from wiki.services import save_document
    other = save_document(workspace['admin'], 'Another', 'document', 'Notes', 'other', workspace['team'], file_format='md')
    with pytest.raises(PermissionDenied):
        touch(other.pk, workspace['member'], sid, {})
    assert PresenceSession.objects.filter(pk=sid).exists()
    remove(document.pk, workspace['member'], sid)
    remove(document.pk, workspace['member'], sid)
    assert not PresenceSession.objects.filter(pk=sid).exists()


def test_presence_keeps_tabs_distinct_and_filters_revoked_users(document, workspace):
    from wiki.presence import touch, list_active
    for _ in range(2):
        touch(document.pk, workspace['member'], str(uuid.uuid4()), {})
    assert len(list_active(document.pk)) == 2
    document.policy['group']['read'] = False
    document.save()
    assert list_active(document.pk) == []
    with pytest.raises(PermissionDenied):
        touch(document.pk, workspace['member'], str(uuid.uuid4()), {})


@pytest.mark.parametrize('selection', [
    {'kind': 'text', 'anchor': 'a' * 2049, 'head': 'b'},
    {'kind': 'text', 'anchor': 5, 'head': 'b'},
    {'kind': 'graph', 'node_ids': ['n'] * 1001},
    {'kind': 'graph', 'node_ids': ['x' * 30] * 500},
    {'kind': 'graph', 'node_ids': [], 'pointer': {'x': float('nan'), 'y': 1}},
    {'kind': 'pointer', 'pointer': {'x': float('inf'), 'y': 1}},
    {'kind': 'pointer', 'pointer': {'x': 10 ** 500, 'y': 1}},
    {'kind': 'table', 'sheet_id': 's', 'row_id': 'r'},
    {'kind': 'unknown'}, [], {'secret': 'arbitrary private data'},
])
def test_presence_rejects_invalid_or_oversized_payload(document, workspace, selection):
    from wiki.presence import touch
    with pytest.raises(ValidationError):
        touch(document.pk, workspace['member'], str(uuid.uuid4()), selection)


def test_presence_stable_table_graph_and_pointer_refs(document, workspace):
    from wiki.presence import touch
    selections = [
        {'kind': 'table', 'sheet_id': 'sheet-stable', 'row_id': 'row-stable', 'column_id': 'col-stable'},
        {'kind': 'graph', 'node_ids': ['node-stable'], 'pointer': {'x': 23.5, 'y': -8}},
        {'kind': 'pointer', 'pointer': {'x': 0, 'y': 12}},
    ]
    for selection in selections:
        assert touch(document.pk, workspace['member'], str(uuid.uuid4()), selection)['selection'] == selection


def test_presence_rejects_invalid_session_identifier(document, workspace):
    from wiki.presence import touch
    with pytest.raises(ValidationError):
        touch(document.pk, workspace['member'], 'invalid-session', {})
