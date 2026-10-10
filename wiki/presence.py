"""Short-lived, authenticated presence; no file writes or CRDT changes."""
from datetime import timedelta
import hashlib
import json
import math
import uuid

from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.utils import timezone

from .models import Document
from .presence_models import PresenceSession
from .services import require

TTL_SECONDS = 30
HEARTBEAT_SECONDS = 10
MAX_SELECTION_BYTES = 8192
# Dark colors with sufficient contrast against light editor surfaces. Names
# accompany every cursor so color is never its sole identifying signal.
PALETTE = ('#185ABC', '#A52714', '#137333', '#7627BB', '#9C4200', '#006878', '#AD1457', '#37474F')


def _id(value):
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        raise ValidationError('Use a valid presence session identifier.') from None


def _selection(value):
    if not isinstance(value, dict):
        raise ValidationError('Invalid presence selection.')
    try:
        encoded = json.dumps(value, allow_nan=False, ensure_ascii=False).encode()
    except (TypeError, ValueError, OverflowError, RecursionError):
        raise ValidationError('Invalid presence selection.') from None
    if len(encoded) > MAX_SELECTION_BYTES:
        raise ValidationError('Presence selection exceeds 8 KB.')
    if not value:
        return {}
    kind = value.get('kind')
    fields = {
        'text': ({'kind', 'anchor', 'head'}, {'pointer'}),
        'table': ({'kind', 'sheet_id', 'row_id', 'column_id'}, {'end_row_id', 'end_column_id', 'pointer'}),
        'graph': ({'kind', 'node_ids'}, {'pointer'}),
        'pointer': ({'kind', 'pointer'}, set()),
    }
    if not isinstance(kind, str) or kind not in fields:
        raise ValidationError('Invalid presence selection kind.')
    required, optional = fields[kind]
    if not required.issubset(value) or not set(value).issubset(required | optional):
        raise ValidationError('Invalid presence selection fields.')
    for key, ref in value.items():
        if key in ('kind', 'node_ids', 'pointer'):
            continue
        if not isinstance(ref, str) or not ref or len(ref) > (2048 if kind == 'text' else 255):
            raise ValidationError('Use bounded stable selection references.')
    if kind == 'graph':
        nodes = value['node_ids']
        if (not isinstance(nodes, list) or len(nodes) > 1000
                or any(not isinstance(node, str) or not node or len(node) > 255 for node in nodes)):
            raise ValidationError('Use at most 1,000 stable node references.')
    if 'pointer' in value:
        pointer = value['pointer']
        if (not isinstance(pointer, dict) or set(pointer) != {'x', 'y'}
                or any(type(coordinate) not in (int, float) or abs(coordinate) > 1e9
                       or not math.isfinite(coordinate) for coordinate in pointer.values())):
            raise ValidationError('Use finite pointer coordinates.')
    # Detach the incoming value from callers who may mutate their local state.
    return json.loads(encoded)


def _entry(session):
    return {'id': str(session.pk), 'user_id': session.user_id, 'name': session.user.label,
            'color': session.color, 'selection': session.selection,
            'expires_at': session.expires_at.isoformat()}


@transaction.atomic
def touch(document_id, user, session_id, selection):
    document = Document.objects.get(pk=document_id)
    require(document, user, 'read')
    identifier, selection = _id(session_id), _selection(selection)
    now = timezone.now()
    color = PALETTE[int(hashlib.sha256(str(user.pk).encode()).hexdigest()[:8], 16) % len(PALETTE)]
    session, _ = PresenceSession.objects.select_for_update().get_or_create(pk=identifier, defaults={
        'document': document, 'user': user, 'color': color, 'selection': selection,
        'heartbeat': now, 'expires_at': now + timedelta(seconds=TTL_SECONDS)})
    if session.user_id != user.pk or session.document_id != document.pk:
        raise PermissionDenied
    session.selection = selection
    session.heartbeat = now
    session.expires_at = now + timedelta(seconds=TTL_SECONDS)
    session.color = color
    session.save(update_fields=['selection', 'heartbeat', 'expires_at', 'color'])
    session.user = user
    return _entry(session)


def list_active(document_id):
    document = Document.objects.get(pk=document_id)
    sessions = PresenceSession.objects.filter(document=document, expires_at__gt=timezone.now()).select_related('user').order_by('heartbeat', 'id')
    result = []
    for session in sessions:
        # Resolve inherited ACL and active-account state on every broadcast.
        try:
            require(document, session.user, 'read')
        except PermissionDenied:
            continue
        result.append(_entry(session))
    return result


@transaction.atomic
def remove(document_id, user, session_id):
    session = PresenceSession.objects.select_for_update().filter(pk=_id(session_id)).first()
    if not session:
        return
    if session.user_id != user.pk or str(session.document_id) != str(document_id):
        raise PermissionDenied
    # The owner may remove a session even after losing read permission.
    session.delete()


def expire(now=None):
    count, _ = PresenceSession.objects.filter(expires_at__lte=now or timezone.now()).delete()
    return count
