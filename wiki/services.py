import json
import logging
import re
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.utils import timezone
from .models import Document, Invitation
from .storage import active_storage, MAX_BYTES

log = logging.getLogger('wiki')
EXTENSIONS = {'document': 'md', 'table': 'csv', 'drawio': 'drawio', 'canvas': 'canvas', 'file': 'bin'}


def storage_key(doc, directory=None, title=None, extension=None):
    from .folders import storage_path
    path = storage_path(doc.folder) if directory is None else directory
    name = re.sub(r'[\\/<>:"|?*\x00-\x1f]', '_', title if title is not None else doc.title).rstrip(' .')[:160] or 'file'
    suffix = '' if doc.kind == 'file' else '.' + (extension or doc.file_format or ('wiki.json' if doc.format_version else EXTENSIONS[doc.kind]))
    return f'{path + "/" if path else ""}{name}{suffix}'

class Conflict(Exception):
    pass


def validate_content(kind, content, limit=5):
    if kind == 'file':
        if not isinstance(content, (str, bytes)) or len(content.encode() if isinstance(content, str) else content) > min(MAX_BYTES, limit*1024*1024):
            raise ValidationError(f'Files must be smaller than {min(5, limit)} MB.')
        return
    if kind not in EXTENSIONS or not isinstance(content, str):
        raise ValidationError('Unsupported document type.')
    if len(content.encode()) > min(MAX_BYTES, limit*1024*1024):
        raise ValidationError(f'Documents must be smaller than {limit} MB.')
    from .native import unpack, validate_native
    native = unpack(content)
    if native:
        validate_native(kind, native)
        return
    if kind == 'table':
        import csv, io
        for index,row in enumerate(csv.reader(io.StringIO(content))):
            if index >= 2000 or len(row)>200:
                raise ValidationError('Tables support up to 2,000 rows and 200 columns.')
    if kind == 'canvas':
        try:
            value = json.loads(content)
            if not isinstance(value, dict) or not isinstance(value.get('nodes'), list) or not isinstance(value.get('edges', []), list):
                raise ValueError()
            if len(value['nodes']) > 1000 or len(value.get('edges', [])) > 5000:
                raise ValueError()
        except (ValueError, TypeError):
            raise ValidationError('Use valid Canvas JSON with a nodes array (at most 1,000 nodes).')
    if kind == 'drawio':
        from defusedxml.ElementTree import fromstring
        try:
            fromstring(content)
        except Exception:
            raise ValidationError('Use valid draw.io XML.')


def validate_policy(policy):
    if not isinstance(policy, dict) or set(policy) != {'owner', 'group', 'everyone'}:
        raise ValidationError('Invalid permission policy.')
    for rule in policy.values():
        if not isinstance(rule, dict) or set(rule) != {'visible', 'read', 'write'} or any(type(v) is not bool for v in rule.values()):
            raise ValidationError('Invalid permission policy.')


def require(doc, user, action):
    if not doc.allows(user, 'visible') or not doc.allows(user, action):
        raise PermissionDenied


@transaction.atomic
def save_document(user, title, kind, collection, content, group, doc=None, revision=None, source_token=None, folder=None, file_format=None):
    # ponytail: SQLite serializes provider writes; use durable per-file leases before scaling writers.
    title, collection = title.strip(), collection.strip()
    if not title or len(title) > 200 or not collection or len(collection) > 100:
        raise ValidationError('Provide a title (up to 200 characters) and collection (up to 100).')
    from .models import SiteConfiguration
    validate_content(kind, content, SiteConfiguration.current().document_limit_mb)
    if doc:
        # Check the persisted revision before touching the existing provider object.
        current = Document.objects.get(pk=doc.pk)
        if current.revision != revision or current.reference != doc.reference or current.folder_id != doc.folder_id:
            raise Conflict('This document changed. Reload it before saving.')
        doc = current
        require(doc, user, 'write')
        from .source import valid, check_available
        if source_token and not valid(doc,user,source_token):
            raise Conflict('The source session expired. Copy your edits before reopening it.')
        if not source_token:
            check_available(doc)
        if hasattr(doc, 'collaboration') and doc.collaboration.state and not source_token:
            raise Conflict('Open the visual editor to edit this collaborative document.')
        if doc.revision != revision:
            raise Conflict('This document changed. Reload it before saving.')
    else:
        doc = Document(title=title, kind=kind, collection=collection, owner=user, group=group, folder=folder,
                       inherit_permissions=bool(folder), path_synced=True)
        from .models import SiteConfiguration
        doc.policy = SiteConfiguration.current().default_document_policy
        doc.file_format = (file_format or 'md') if kind == 'document' else 'ods' if kind == 'table' else ''
    if file_format and (file_format not in ('md', 'docx', 'ods') or kind == 'document' and file_format not in ('md', 'docx')):
        raise ValidationError('Unsupported file format.')
    if not doc.file_format and kind in ('document', 'table'):
        doc.file_format = 'md' if kind == 'document' else 'ods'
    adapter = active_storage()
    from .native import unpack
    key = storage_key(doc, title=title, extension='wiki.json' if not doc.file_format and kind != 'file' and unpack(content) else None)
    if doc.folder:
        adapter.ensure_dir(key.rpartition('/')[0])
    same_object = not doc._state.adding
    from .file_history import persist
    reference = persist(doc, content, key, new=not same_object, adapter=adapter)
    try:
        # The outer IMMEDIATE transaction keeps revision/ACL/lease checks valid.
        # Do not recheck a time-limited lease after writing the provider object.
        doc.title, doc.collection, doc.reference, doc.path_synced = title, collection, reference, True
        doc.format_version = 1 if kind != 'file' and unpack(content) else 0
        if same_object:
            doc.updated_at = timezone.now()
            doc.revision += 1
        doc.save()
        if source_token:
            from .models import Collaboration, SourceLease
            Collaboration.objects.filter(document=doc).delete()
            SourceLease.objects.filter(document=doc).delete()
    except Exception:
        try:
            if not same_object:
                adapter.delete(reference)
        except Exception:
            log.warning('Orphan revision cleanup failed for document %s', doc.pk)
        raise
    return doc


def redeem_invitation(token, user):
    with transaction.atomic():
        invitation = Invitation.objects.filter(token_hash=Invitation.digest(token)).first()
        if not invitation or not invitation.valid():
            raise PermissionDenied
        creator = invitation.creator
        groups = list(invitation.groups.all())
        if not creator.is_active or (not creator.is_superuser and (not creator.can_invite or any(not creator.invite_groups.filter(pk=g.pk).exists() for g in groups))):
            raise PermissionDenied
        user.full_clean(exclude=['password'])
        user.save()
        user.groups.set(groups)
        invitation.uses += 1
        invitation.save(update_fields=['uses'])
        return user


def delete_document(user, doc):
    from .models import PendingDeletion
    with transaction.atomic():
        current = Document.objects.get(pk=doc.pk)
        require(current, user, 'write')
        if current.revision != doc.revision:
            raise Conflict('This document changed. Reload before deleting.')
        job = PendingDeletion.objects.create(reference=current.reference)
        if current.history_reference:
            PendingDeletion.objects.create(reference=current.history_reference)
        for attachment in current.attachments.all():
            PendingDeletion.objects.create(reference=attachment.reference)
        current.delete()
    # The catalog deletion and cleanup task commit together. If the provider is
    # offline, access is still removed and the worker retries the physical deletion.
    try:
        active_storage().delete(job.reference)
    except Exception:
        return False
    job.delete()
    return True


def cleanup_storage():
    from .models import PendingDeletion
    jobs = list(PendingDeletion.objects.order_by('pk')[:100])
    if not jobs:
        return
    adapter = active_storage()
    for job in jobs:
        try:
            adapter.delete(job.reference)
        except Exception:
            log.warning('Storage deletion retry pending id=%s', job.pk)
            break
        job.delete()
