import hashlib
import uuid
from django.contrib.auth.models import AbstractUser, Group
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


def default_policy():
    return {scope: {action: scope == 'owner' or (scope == 'group' and action != 'write') for action in ('read', 'write')} for scope in ('owner', 'group', 'everyone')}

class User(AbstractUser):
    display_name = models.CharField(max_length=150)
    provider_setup_required = models.BooleanField(default=False)
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
    document_limit_mb = models.PositiveBigIntegerField(default=5)
    image_limit_mb = models.PositiveBigIntegerField(default=5)
    image_limit_megapixels = models.PositiveSmallIntegerField(default=16)
    sync_interval_seconds = models.PositiveSmallIntegerField(default=3)
    encrypted_ai_config = models.TextField(blank=True, default='')
    encrypted_google_oauth_client = models.TextField(blank=True, default='')
    encrypted_identity_oauth_clients = models.TextField(blank=True, default='')
    revision_history = models.BooleanField(default=False)
    default_collection = models.CharField(max_length=100, default='Getting started')
    default_document_policy = models.JSONField(default=default_policy)

    @classmethod
    def current(cls):
        return cls.objects.filter(pk=1).first() or cls(pk=1)


class TrashEntry(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    root_id = models.UUIDField()
    kind = models.CharField(max_length=8, choices=[('file', 'File'), ('folder', 'Folder')])
    name = models.CharField(max_length=200)
    original_path = models.TextField(blank=True)
    deleted_at = models.DateTimeField(default=timezone.now)
    deleted_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL)

    class Meta:
        ordering = ['-deleted_at']


class ProviderTrashState(models.Model):
    document = models.OneToOneField('Document', on_delete=models.CASCADE, related_name='provider_trash')
    mount = models.ForeignKey(MountPoint, on_delete=models.PROTECT)
    reference = models.TextField()
    confirmed = models.BooleanField(default=False)
    error = models.TextField(blank=True)
    checked_at = models.DateTimeField(null=True, blank=True)


class ActiveObjects(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(trash__isnull=True)


class AccessPolicy:
    def history_enabled(self):
        return SiteConfiguration.current().revision_history

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
        from .acl import normalize_policy
        site = getattr(self, '_access_site', None)
        policy = (site or SiteConfiguration.current()).default_document_policy if item.inherit_permissions and item.parent_policy is None else item.policy
        return normalize_policy(policy), item.group_id

    def allows(self, user, action):
        item, seen = self, set()
        while item is not None:
            key = (type(item).__name__, item.pk)
            if key in seen or getattr(item, 'trash_id', None):
                return False
            seen.add(key)
            item = item.parent_policy
        if action not in ('read', 'write', 'visible'):
            return False
        action = 'read' if action == 'visible' else action
        if not user.is_authenticated or not user.is_active:
            return False
        if user.is_superuser:
            return True
        source = self.effective_source()
        from .acl import normalize_rule
        policy, group_id = self.effective_policy()
        personal_source = self
        while personal_source is not None:
            personal = personal_source.user_policies or {}
            if str(user.pk) in personal:
                return normalize_rule(personal[str(user.pk)]).get(action) is True
            if not personal_source.inherit_permissions:
                break
            personal_source = personal_source.parent_policy
        cached_groups = getattr(self, '_access_groups', None)
        def in_group(value):
            if cached_groups is not None and cached_groups[0] == user.pk:
                return str(value) in cached_groups[1]
            return user.groups.filter(pk=value).exists()
        if isinstance(source, (Folder, Document)):
            grants = {} if source.inherit_permissions and source.parent_policy is None else (source.group_policies or {})
            allowed = [normalize_rule(rules).get(action) is True for gid, rules in grants.items()
                       if in_group(gid)]
            if allowed:
                return any(allowed)
        scope = 'owner' if user.pk == source.owner_id else 'group' if in_group(group_id) else 'everyone'
        return policy.get(scope, {}).get(action) is True


class Folder(AccessPolicy, models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    parent = models.ForeignKey('self', null=True, blank=True, on_delete=models.PROTECT, related_name='children')
    owner = models.ForeignKey(User, on_delete=models.PROTECT)
    group = models.ForeignKey(Group, on_delete=models.PROTECT)
    policy = models.JSONField(default=default_policy)
    group_policies = models.JSONField(default=dict)
    user_policies = models.JSONField(default=dict)
    inherit_permissions = models.BooleanField(default=True)
    revision_history = models.BooleanField(null=True, blank=True, default=None)

    trash = models.ForeignKey(TrashEntry, null=True, blank=True, on_delete=models.PROTECT)
    objects = ActiveObjects()
    all_objects = models.Manager()

    @property
    def parent_policy(self):
        return self.parent

    class Meta:
        base_manager_name = 'all_objects'
        default_manager_name = 'objects'
        ordering = ['name', 'id']

    def __str__(self):
        return self.name

class Document(AccessPolicy, models.Model):
    KINDS = [('document', _('Document')), ('table', _('Table')), ('presentation', _('Presentation')), ('drawio', _('Draw.io')), ('canvas', _('Canvas')), ('file', _('File'))]
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title = models.CharField(max_length=200)
    kind = models.CharField(max_length=15, choices=KINDS)
    collection = models.CharField(max_length=100, default='Getting started')
    owner = models.ForeignKey(User, on_delete=models.PROTECT)
    group = models.ForeignKey(Group, on_delete=models.PROTECT)
    policy = models.JSONField(default=default_policy)
    group_policies = models.JSONField(default=dict)
    user_policies = models.JSONField(default=dict)
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

    trash = models.ForeignKey(TrashEntry, null=True, blank=True, on_delete=models.PROTECT)
    objects = ActiveObjects()
    all_objects = models.Manager()


    class Meta:
        base_manager_name = 'all_objects'
        default_manager_name = 'objects'
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
    generation = models.UUIDField(default=uuid.uuid4, editable=False)
    state = models.BinaryField(default=bytes)
    sequence = models.PositiveBigIntegerField(default=0)
    synced_sequence = models.PositiveBigIntegerField(default=0)
    saved_structure = models.JSONField(default=dict)
    snapshot = models.TextField(default='')
    updated_at = models.DateTimeField(auto_now=True)


class WriteAttempt(models.Model):
    """Query index for durable provider write intents; journal survives SQL rollback."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name='write_attempts')
    state = models.CharField(max_length=16, default='unknown')
    expected_fingerprint = models.CharField(max_length=64, blank=True)
    intended_digest = models.CharField(max_length=64)
    confirmed_fingerprint = models.CharField(max_length=64, blank=True)
    reference = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)


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
    directory = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)


class ProviderIdentity(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='provider_identities')
    provider = models.CharField(max_length=16, choices=[('google','Google Drive'),('onedrive','OneDrive'),('github','GitHub')])
    external_id = models.CharField(max_length=255)
    email = models.EmailField(blank=True)
    login = models.CharField(max_length=255, blank=True)
    active = models.BooleanField(default=True)
    verified_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user','provider'],name='identity_user_provider'),
                       models.UniqueConstraint(fields=['provider','external_id'],name='identity_provider_subject')]


class ProviderGrant(models.Model):
    mount = models.ForeignKey(MountPoint, on_delete=models.PROTECT, related_name='provider_grants')
    user = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name='provider_grants')
    provider = models.CharField(max_length=16)
    object_key = models.CharField(max_length=512)
    reference = models.TextField()
    recipient = models.CharField(max_length=255, blank=True)
    desired_role = models.CharField(max_length=8, blank=True)
    applied_role = models.CharField(max_length=8, blank=True)
    permission_id = models.CharField(max_length=255, blank=True)
    status = models.CharField(max_length=12, default='pending', choices=[('pending','Pending'),('synced','Synced'),('failed','Failed'),('revoked','Revoked')])
    error = models.TextField(blank=True)
    attempted_at = models.DateTimeField(null=True, blank=True)

    @property
    def provider_label(self):
        return {'google':'Google Drive','onedrive':'OneDrive','github':'GitHub'}.get(self.provider,self.provider)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['provider','object_key','user'],name='provider_object_user_grant')]


class SaveSession(models.Model):
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name='save_sessions')
    client_id = models.CharField(max_length=160)
    author = models.ForeignKey(User, null=True, on_delete=models.SET_NULL)
    base_revision = models.PositiveIntegerField()
    base_etag = models.CharField(max_length=255, blank=True)
    payload = models.BinaryField(default=bytes)
    payload_hash = models.CharField(max_length=64)
    sequence = models.PositiveBigIntegerField(default=0)
    saved_revision = models.PositiveIntegerField(null=True)
    state = models.CharField(max_length=12, default='pending', choices=[(s,s) for s in ('pending','saved','failed','conflict','denied','unknown')])
    error = models.TextField(blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['document','client_id'],name='save_document_client')]


from .pdf_models import PdfAnnotationLayer
from .presence_models import PresenceSession


class OfficeSession(models.Model):
    """Shared binary office session; failed uploads survive for recovery."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(Document, on_delete=models.CASCADE)
    superseded = models.BooleanField(default=False)
    expires_at = models.DateTimeField()
    base_digest = models.CharField(max_length=255)
    lock = models.CharField(max_length=1024, blank=True)
    lock_expires_at = models.DateTimeField(null=True)
    pending = models.BinaryField(default=bytes)
    pending_author = models.ForeignKey(User, null=True, on_delete=models.SET_NULL)
    error = models.TextField(blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['document'], condition=models.Q(superseded=False), name='current_office_session')]
