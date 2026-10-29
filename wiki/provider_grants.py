"""Durable, retryable personal sharing derived exclusively from effective ACL.

Never share folders: provider inheritance cannot represent a denied child.
GitHub cannot represent per-file ACLs; reconcile its old receipts only to revoke.
"""
import hashlib
import logging
import fcntl
from contextlib import contextmanager
from django.conf import settings
from django.contrib.auth.models import Group
from django.db import transaction
from django.db.models.signals import pre_save, post_save, post_delete, m2m_changed
from django.utils import timezone
from .crypto import decrypt
from .models import Document, Folder, User, SiteConfiguration, ProviderIdentity, ProviderGrant
from .storage import MountedStorage, mount_adapter

PROVIDERS = ('google', 'onedrive')
log = logging.getLogger(__name__)


def target(mount, reference, resolve=False):
    config = decrypt(mount.encrypted_config)
    if mount.provider == 'github':
        return 'repo:' + config['repository'].lower()
    namespace = ''
    if mount.provider == 'onedrive':
        namespace = config.get('drive_id', '')
        if not namespace and resolve:
            namespace = mount_adapter(mount).drive_id()
        if not namespace:
            # A display-only placeholder. Never issue a permission for this key.
            return f'unresolved:{mount.pk}:' + hashlib.sha256(reference.encode()).hexdigest()
    return hashlib.sha256(f'{namespace}:{reference}'.encode()).hexdigest()


@contextmanager
def sync_lock(blocking=True):
    # Also serialize management-command retries and separate web processes.
    with (settings.SECRETS_DIR / 'provider-grants.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def sync_provider_grants(force=False):
    with sync_lock():
        reconcile(force=force)


def reconcile(force=False):
    _sync(force=force)
    from .export_restrictions import sync
    sync(force=force)
    from .cloud_trash import synchronize
    from .models import ProviderTrashState
    pending=list(ProviderTrashState.objects.filter(confirmed=False,document__trash__isnull=False).values_list('document_id',flat=True))
    if pending:synchronize(pending)


def _sync(force=False):
    users = list(User.objects.filter(is_active=True))
    identities = {(i.user_id,i.provider):i for i in ProviderIdentity.objects.filter(active=True)}
    memberships={}
    for user_id,group_id in User.groups.through.objects.values_list('user_id','group_id'):
        memberships.setdefault(user_id,set()).add(str(group_id))
    for user in users:user._acl_group_ids=memberships.get(user.pk,set())
    site=SiteConfiguration.current()
    folders={folder.pk:folder for folder in Folder.all_objects.all()}
    for folder in folders.values():
        folder._state.fields_cache['parent']=folders.get(folder.parent_id)
        folder._access_site=site
    desired = {}
    blocked_mounts = set()
    scope_keys = {}
    for doc in Document.objects.exclude(reference='').select_related('folder','owner','group'):
        doc._state.fields_cache['folder']=folders.get(doc.folder_id)
        doc._access_site=site
        mount, reference = MountedStorage().reference(doc.reference)
        if mount.provider not in PROVIDERS:
            continue
        try:
            if mount.pk in blocked_mounts:
                raise ValueError('Unresolved drive')
            scope_index = (mount.pk, reference)
            if scope_index not in scope_keys:
                scope_keys[scope_index] = target(mount, reference, resolve=True)
            key = scope_keys[scope_index]
        except Exception:
            blocked_mounts.add(mount.pk)
            key = target(mount, reference)
        for user in users:
            if not doc.allows(user,'read'):
                continue
            identity = identities.get((user.pk,mount.provider))
            recipient = (identity.login if mount.provider == 'github' else identity.email) if identity else ''
            role = 'write' if doc.allows(user,'write') else 'read'
            index = (mount.provider,key,user.pk)
            if index not in desired or role == 'write':
                desired[index] = (mount,reference,recipient,role)
    receipts = list(ProviderGrant.objects.select_related('mount'))
    existing = {(g.provider,g.object_key,g.user_id):g for g in receipts if g.user_id is not None}
    for index, values in desired.items():
        if index not in existing:
            mount,reference,recipient,role = values
            grant = ProviderGrant.objects.create(mount=mount,provider=index[0],object_key=index[1],user_id=index[2],reference=reference)
            existing[index] = grant
            receipts.append(grant)
    # Revocations first. Keep the old receipt until DELETE succeeds, including
    # ambiguous POST failures (recipient is written before the network call).
    for grant in receipts:
        index = (grant.provider, grant.object_key, grant.user_id)
        wanted = desired.get(index)
        recipient = wanted[2] if wanted else ''
        role = wanted[3] if wanted else ''
        grant.desired_role = role
        if grant.mount_id in blocked_mounts:
            grant.status='failed';grant.error='Provider drive identity could not be verified. Retry synchronization.'
            grant.save();continue
        if grant.recipient and (not recipient or recipient.casefold() != grant.recipient.casefold()):
            try:
                grant.attempted_at=timezone.now();grant.save(update_fields=['desired_role','attempted_at'])
                mount_adapter(grant.mount).revoke_grant(grant.reference,grant.recipient,grant.permission_id)
                grant.recipient='';grant.permission_id='';grant.applied_role=''
            except Exception:
                grant.status='failed';grant.error='Provider revocation failed. External access may remain; retry synchronization.'
                grant.save();continue
        if not wanted or not recipient:
            grant.status='pending' if wanted else 'revoked'
            grant.error='Link a verified provider account to access the original.' if wanted else ''
            grant.save();continue
        mount,reference,recipient,role = wanted
        grant.mount=mount;grant.reference=reference
        if not force and grant.applied_role == role and grant.status == 'synced' and grant.recipient == recipient:
            continue
        grant.recipient=recipient;grant.status='pending';grant.error='';grant.attempted_at=timezone.now()
        grant.save()  # Outbox receipt survives provider failure or process exit.
        try:
            grant.permission_id=mount_adapter(mount).set_grant(reference,recipient,role,grant.permission_id)
            grant.applied_role=role;grant.status='pending' if grant.permission_id.startswith('invitation:') else 'synced'
            grant.error='Accept the repository invitation in GitHub to access the original.' if grant.status=='pending' else ''
        except Exception as error:
            from .provider_sharing import GrantUnavailable
            grant.status='failed';grant.error=str(error) if isinstance(error,GrantUnavailable) else 'Provider synchronization failed. Local permissions are saved; external access may differ. Retry synchronization.'
        grant.save()


def enqueue_sync(*, force=False):
    from django.db.models import F
    from .models import ProviderSyncState
    ProviderSyncState.objects.get_or_create(pk=1)
    values={'requested_revision':F('requested_revision')+1,'requested_at':timezone.now()}
    if force:values['force_revision']=F('requested_revision')+1
    ProviderSyncState.objects.filter(pk=1).update(**values)


def synchronize_after_commit():
    # Commit the local action promptly; network reconciliation is independent.
    transaction.on_commit(enqueue_sync)


def process_pending(*, retry=False):
    from django.db import close_old_connections, connection
    from .models import ProviderSyncState, ProviderExportRestriction
    if not connection.in_atomic_block:close_old_connections()
    try:
        with sync_lock(blocking=False) as acquired:
            if not acquired:return False
            state,_=ProviderSyncState.objects.get_or_create(pk=1)
            if not state.pending and not retry:return False
            revision=state.requested_revision
            if not retry and state.error and state.attempted_revision==revision:return False
            ProviderSyncState.objects.filter(pk=1).update(attempted_revision=revision,attempted_at=timezone.now())
            try:
                reconcile(force=state.force_revision>state.completed_revision)
                failed=ProviderGrant.objects.filter(status='failed').exists() or ProviderExportRestriction.objects.exclude(error='').exists()
                error='Cloud permissions are still synchronizing. Failed operations will retry automatically.' if failed else ''
            except Exception:
                ProviderSyncState.objects.filter(pk=1).update(error='Cloud permission synchronization will retry automatically.')
                log.warning('Provider permission synchronization deferred')
                return False
            # Do not acknowledge requests added while remote calls were in flight.
            ProviderSyncState.objects.filter(pk=1).update(completed_revision=revision,completed_at=timezone.now(),error=error)
            return True
    finally:
        if not connection.in_atomic_block:close_old_connections()


async def synchronize_background():
    import asyncio
    import time
    from asgiref.sync import sync_to_async
    # Recover a process that exited after local commit but before its callback.
    await sync_to_async(enqueue_sync,thread_sensitive=False)()
    last_retry=0
    while True:
        try:
            now=time.monotonic()
            retry=now-last_retry>=60
            await sync_to_async(process_pending,thread_sensitive=False)(retry=retry)
            if retry:last_retry=now
        except Exception:
            log.warning('Provider permission worker deferred')
        await asyncio.sleep(1)


WATCHED = {
    Document: ('policy','group_policies','user_policies','inherit_permissions','group_id','owner_id','folder_id','reference','export_disabled'),
    Folder: ('policy','group_policies','user_policies','inherit_permissions','group_id','owner_id','parent_id','export_disabled'),
    User: ('is_active','is_superuser','is_simple_admin'),
    SiteConfiguration: ('default_document_policy','export_disabled'),
    ProviderIdentity: ('user_id','provider','active','email','login','external_id'),
}


def before_save(sender, instance, raw=False, update_fields=None, **kwargs):
    if raw or instance._state.adding:
        return
    fields = WATCHED[sender]
    if update_fields is not None:
        fields = tuple(name for name in fields if name in update_fields or name.removesuffix('_id') in update_fields)
    if not fields:
        instance._grants_changed = False
        return
    before = sender.objects.filter(pk=instance.pk).values(*fields).first()
    instance._grants_changed = before is None or any(before[name] != getattr(instance,name) for name in fields)


def changed(sender, instance, raw=False, update_fields=None, created=None, **kwargs):
    if raw:
        return
    fields = WATCHED.get(sender, ())
    if update_fields is not None and not any(name in update_fields or name.removesuffix('_id') in update_fields for name in fields):
        return
    if created is False and not getattr(instance, '_grants_changed', True):
        return
    synchronize_after_commit()


def membership_changed(sender, action, **kwargs):
    if action in ('post_add','post_remove','post_clear'):
        synchronize_after_commit()


def connect_signals():
    for model in WATCHED:
        pre_save.connect(before_save,sender=model,dispatch_uid=f'grant-before-{model.__name__}')
        post_save.connect(changed,sender=model,dispatch_uid=f'grant-save-{model.__name__}')
        post_delete.connect(changed,sender=model,dispatch_uid=f'grant-delete-{model.__name__}')
    post_delete.connect(changed,sender=Group,dispatch_uid='grant-delete-Group')
    m2m_changed.connect(membership_changed,sender=User.groups.through,dispatch_uid='grant-membership')
