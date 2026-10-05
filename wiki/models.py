import hashlib
import uuid
from django.contrib.auth.models import AbstractUser, Group
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


def default_policy():
    return {scope: {action: scope == 'owner' or (scope == 'group' and action != 'write') for action in ('visible', 'read', 'write')} for scope in ('owner', 'group', 'everyone')}

class User(AbstractUser):
    display_name = models.CharField(max_length=150)
    can_invite = models.BooleanField(default=False)
    invite_groups = models.ManyToManyField(Group, related_name='authorized_inviters', blank=True)

    @property
    def label(self):
        return self.display_name or self.username

class Workspace(models.Model):
    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    provider = models.CharField(max_length=20)
    encrypted_config = models.TextField()
    initialized = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)


class MountPoint(models.Model):
    path = models.CharField(max_length=2048, unique=True)
    folder = models.OneToOneField('Folder', null=True, blank=True, on_delete=models.PROTECT, related_name='mountpoint')
    provider = models.CharField(max_length=20)
    encrypted_config = models.TextField()
    revision_history = models.BooleanField(null=True, blank=True, default=None)

    class Meta:
        ordering = ['path']

    def __str__(self):
        return self.path


class SiteConfiguration(models.Model):
    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    name = models.CharField(max_length=100, default='My workspace')
    description = models.CharField(max_length=200, default='Your shared knowledge')
    session_hours = models.PositiveIntegerField(default=24)
    invite_days = models.PositiveIntegerField(default=7)
    invite_uses = models.PositiveIntegerField(default=1)
    login_attempts = models.PositiveIntegerField(default=10)
    login_window_minutes = models.PositiveIntegerField(default=15)
    document_limit_mb = models.PositiveSmallIntegerField(default=5)
    image_limit_mb = models.PositiveSmallIntegerField(default=5)
    image_limit_megapixels = models.PositiveSmallIntegerField(default=16)
    sync_interval_seconds = models.PositiveSmallIntegerField(default=3)
    encrypted_ai_config = models.TextField(blank=True, default='')
    encrypted_google_oauth_client = models.TextField(blank=True, default='')
    revision_history = models.BooleanField(default=False)
    default_collection = models.CharField(max_length=100, default='Getting started')
    default_document_policy = models.JSONField(default=default_policy)

    @classmethod
    def current(cls):
        return cls.objects.filter(pk=1).first() or cls(pk=1)


class AccessPolicy:
    def history_enabled(self):
        item = self
        while item is not None:
            if item.revision_history is not None:
                return item.revision_history
            item = item.parent_policy
        from .storage import active_storage
        from .folders import storage_path
        mount, _ = active_storage().resolve(storage_path(self) if isinstance(self, Folder) else (storage_path(self.folder) + '/_' if self.folder else '_'))
        return mount.revision_history if mount.revision_history is not None else SiteConfiguration.current().revision_history

    def effective_source(self):
        item, seen = self, set()
        while item.inherit_permissions and item.parent_policy is not None:
            key = (type(item).__name__, item.pk)
            if key in seen: return item
            seen.add(key)
            item = item.parent_policy
        return item

    def effective_policy(self):
        item = self.effective_source()
        return item.policy, item.group_id

    def allows(self, user, action):
        if not user.is_authenticated or not user.is_active:
            return False
        if user.is_superuser:
            return True
        source = self.effective_source()
        policy, group_id = source.policy, source.group_id
        if isinstance(source, (Folder, Document)):
            grants = source.group_policies or {}
            allowed = [rules.get(action) is True for gid, rules in grants.items()
                       if user.groups.filter(pk=gid).exists()]
            if allowed:
                return any(allowed)
        scope = 'owner' if user.pk == source.owner_id else 'group' if user.groups.filter(pk=group_id).exists() else 'everyone'
        return policy.get(scope, {}).get(action) is True


class Folder(AccessPolicy, models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    parent = models.ForeignKey('self', null=True, blank=True, on_delete=models.PROTECT, related_name='children')
    owner = models.ForeignKey(User, on_delete=models.PROTECT)
    group = models.ForeignKey(Group, on_delete=models.PROTECT)
    policy = models.JSONField(default=default_policy)
    group_policies = models.JSONField(default=dict)
    inherit_permissions = models.BooleanField(default=True)
    revision_history = models.BooleanField(null=True, blank=True, default=None)

    @property
    def parent_policy(self):
        return self.parent

    class Meta:
        ordering = ['name', 'id']

    def __str__(self):
        return self.name

class Document(AccessPolicy, models.Model):
    KINDS = [('document', _('Document')), ('table', _('Table')), ('drawio', _('Draw.io')), ('canvas', _('Canvas')), ('file', _('File'))]
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title = models.CharField(max_length=200)
    kind = models.CharField(max_length=15, choices=KINDS)
    collection = models.CharField(max_length=100, default='Getting started')
    owner = models.ForeignKey(User, on_delete=models.PROTECT)
    group = models.ForeignKey(Group, on_delete=models.PROTECT)
    policy = models.JSONField(default=default_policy)
    group_policies = models.JSONField(default=dict)
    revision = models.PositiveIntegerField(default=1)
    reference = models.TextField()
    starred = models.BooleanField(default=False)
    updated_at = models.DateTimeField(default=timezone.now)
    folder = models.ForeignKey(Folder, null=True, blank=True, on_delete=models.PROTECT, related_name='documents')
    inherit_permissions = models.BooleanField(default=True)
    revision_history = models.BooleanField(null=True, blank=True, default=None)
    format_version = models.PositiveSmallIntegerField(default=0)
    path_synced = models.BooleanField(default=False)
    file_format = models.CharField(max_length=12, blank=True, default='')
    storage_digest = models.CharField(max_length=64, blank=True, default='')
    history_reference = models.TextField(blank=True, default='')


    class Meta:
        ordering = ['-updated_at']

    @property
    def original_url(self):
        from .storage import active_storage, StorageError
        try:
            return active_storage().original_url(self.reference)
        except StorageError:
            return ''

    @property
    def parent_policy(self):
        return self.folder


class Collaboration(models.Model):
    document = models.OneToOneField(Document, primary_key=True, on_delete=models.CASCADE)
    state = models.BinaryField(default=bytes)
    sequence = models.PositiveBigIntegerField(default=0)
    synced_sequence = models.PositiveBigIntegerField(default=0)
    snapshot = models.TextField(default='')
    updated_at = models.DateTimeField(auto_now=True)


class Review(models.Model):
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name='reviews')
    author = models.ForeignKey(User, on_delete=models.PROTECT)
    author_label = models.CharField(max_length=150, blank=True, default='')
    kind = models.CharField(max_length=12, default='comment')
    body = models.TextField()
    anchor = models.JSONField(default=dict)
    status = models.CharField(max_length=12, default='open')
    created_at = models.DateTimeField(auto_now_add=True)
    resolved_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name='+')


class SourceLease(models.Model):
    document = models.OneToOneField(Document, primary_key=True, on_delete=models.CASCADE)
    owner = models.ForeignKey(User, on_delete=models.CASCADE)
    token_hash = models.CharField(max_length=64)
    expires_at = models.DateTimeField()


class Attachment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name='attachments')
    reference = models.TextField()
    content_type = models.CharField(max_length=50)

class Invitation(models.Model):
    token_hash = models.CharField(max_length=64, unique=True)
    creator = models.ForeignKey(User, on_delete=models.PROTECT)
    groups = models.ManyToManyField(Group)
    expires_at = models.DateTimeField(null=True, blank=True)
    max_uses = models.PositiveIntegerField(default=1)  # zero means unlimited
    uses = models.PositiveIntegerField(default=0)
    revoked = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    @staticmethod
    def digest(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def valid(self):
        return not self.revoked and (not self.expires_at or self.expires_at > timezone.now()) and (not self.max_uses or self.uses < self.max_uses)

class LoginAttempt(models.Model):
    key = models.CharField(primary_key=True, max_length=64)
    count = models.PositiveIntegerField(default=0)
    started_at = models.DateTimeField(default=timezone.now)

class PendingDeletion(models.Model):
    reference = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
