"""Administrator-managed mountpoints in the shared filesystem namespace."""
from pathlib import Path
import secrets
import time
from django.conf import settings
from django import forms
from django.contrib import messages
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_http_methods
from django.views.decorators.debug import sensitive_post_parameters
from django.urls import reverse
from django.utils.translation import gettext as _
from .crypto import decrypt, encrypt
from .models import Attachment, Document, Folder, MountPoint, PendingDeletion, Workspace, SiteConfiguration
from .storage import ADAPTERS, SafeAdapter, mount_adapter, root_mount
from .views import guarded

PROVIDERS = {'local':'Local directory', 'google':'Google Drive', 'onedrive':'OneDrive',
             'github':'GitHub', 'smb':'SMB', 'sftp':'SFTP'}
FIELDS = {
    'local': ['root'],
    'google': ['root', 'client_id', 'client_secret', 'refresh_token'],
    'onedrive': ['root', 'tenant', 'client_id', 'client_secret', 'refresh_token'],
    'github': ['root', 'repository', 'branch', 'token'],
    'smb': ['root', 'host', 'port', 'share', 'domain', 'username', 'password'],
    'sftp': ['root', 'host', 'port', 'host_key', 'username', 'password', 'private_key', 'key_passphrase'],
}
SECRETS = {'client_secret', 'refresh_token', 'token', 'password', 'private_key', 'key_passphrase'}
IDENTITY = {'root', 'repository', 'branch', 'host', 'port', 'share', 'host_key'}


from .forms import HistoryForm


class MountForm(HistoryForm):
    path = forms.CharField(label='Mount path', max_length=2048, help_text='Absolute path, for example /projects/archive. Missing parent directories are created.')

    def __init__(self, *args, provider='local', mount=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.provider, self.mount = provider, mount
        self.old = decrypt(mount.encrypted_config) if mount else {}
        self.saved_client = {}
        if provider == 'google' and not mount:
            saved = SiteConfiguration.current().encrypted_google_oauth_client
            self.saved_client = decrypt(saved) if saved else {}
            if self.saved_client:
                self.fields['use_saved_client'] = forms.BooleanField(required=False, initial=True,
                    label='Use the Google OAuth client saved during installation',
                    help_text='Uncheck to enter another client ID and secret. Saved credentials stay on the server.')
        if mount:
            self.fields['revision_history'].initial = '' if mount.revision_history is None else 'on' if mount.revision_history else 'off'
            self.fields['path'].initial = mount.path
            self.fields['path'].disabled = True
        for name in FIELDS[provider]:
            if provider == 'google' and not mount and name == 'refresh_token':
                continue
            field = forms.IntegerField(min_value=1, max_value=65535) if name == 'port' else forms.CharField(required=False)
            if name in SECRETS:
                field.widget = forms.PasswordInput()
                if mount:
                    field.help_text = 'Leave blank to retain the current credential.'
                if name == 'private_key':
                    field.widget = forms.Textarea(attrs={'rows':4, 'spellcheck':'false'})
            else:
                field.initial = self.old.get(name, {'branch':'main', 'tenant':'common', 'port':22 if provider == 'sftp' else 445}.get(name, ''))
            if mount and name in IDENTITY:
                field.disabled = True
            self.fields[name] = field
        self.fields['root'].label = {'local':'Directory inside the Docker container', 'google':'Drive folder ID', 'onedrive':'OneDrive folder ID'}.get(provider, 'Provider directory')
        self.fields['root'].help_text = 'This is the provider location attached at the mount path.'
        if provider == 'google' and not mount:
            self.fields['root'].help_text = 'Leave blank to create a new Google Drive folder. An existing folder must be accessible to this OAuth app.'
        if 'host_key' in self.fields:
            self.fields['host_key'].help_text = 'Verified SSH host key: key type followed by its base64 value.'

    def clean_path(self):
        from .folders import validate_directory_name
        path = self.cleaned_data['path'].rstrip('/') or '/'
        if self.mount:
            return path
        if not path.startswith('/') or path == '/':
            raise ValidationError('The root / already exists. Enter an absolute subdirectory path.')
        parts = path[1:].split('/')
        if len(parts) > 32:
            raise ValidationError('Use at most 32 directory levels.')
        for part in parts:
            validate_directory_name(part)
        if MountPoint.objects.filter(path=path).exists():
            raise ValidationError('This path is already mounted.')
        return path

    def clean(self):
        data = super().clean()
        config = {**self.old, 'provider':self.provider}
        for name in FIELDS[self.provider]:
            value = data.get(name)
            if name in SECRETS and not value and self.mount:
                continue
            config[name] = value if value is not None else ''
        if self.provider == 'google' and not self.mount and data.get('use_saved_client'):
            config.update(self.saved_client)
        from install import validate_config
        if self.provider == 'onedrive':
            config['tenant'] = config.get('tenant') or 'common'
        try:
            validate_config(config)
            if (self.provider == 'onedrive' or self.provider == 'google' and self.mount) and not all(config.get(name) for name in ('root', 'refresh_token')):
                raise ValueError('Provide the provider folder ID and OAuth refresh token.')
            if self.provider == 'sftp' and not (config.get('password') or config.get('private_key')):
                raise ValueError('Provide an SFTP password or private key.')
            if self.provider == 'local' and not Path(config['root']).is_absolute():
                raise ValueError('Use an absolute directory inside the Docker container.')
        except ValueError as error:
            raise ValidationError(str(error)) from None
        self.config = config
        return data


def create_mount(user, path, config):
    if not user.is_superuser:
        raise PermissionDenied
    from .folders import validate_directory_name, storage_path
    if not path.startswith('/') or path == '/' or len(path) > 2048:
        raise ValidationError('Use an absolute subdirectory mount path.')
    parts = path[1:].split('/')
    if len(parts) > 32:
        raise ValidationError('Use at most 32 directory levels.')
    for part in parts:
        validate_directory_name(part)
    root_mount()
    with transaction.atomic():
        if MountPoint.objects.filter(path=path).exists():
            raise ValidationError('This path is already mounted.')
        parent = None
        group = user.groups.first()
        if not group:
            from django.contrib.auth.models import Group
            group = Group.objects.first()
        if not group:
            raise ValidationError('Create a group before adding a mount.')
        for part in parts:
            matches = list(Folder.objects.filter(parent=parent, name__iexact=part))
            if len(matches) > 1 or matches and matches[0].name != part:
                raise ValidationError('Mount path conflicts with an existing directory name.')
            parent = matches[0] if matches else Folder.objects.create(name=part, parent=parent, owner=user, group=group)
        if parent.children.exists() or parent.documents.exists():
            raise ValidationError('Mount onto an empty directory so existing files are not hidden.')
        from .storage import active_storage
        active_storage().ensure_dir(storage_path(parent))
        return MountPoint.objects.create(path=path, folder=parent, provider=config['provider'], encrypted_config=encrypt(config))


@sensitive_post_parameters('client_secret', 'refresh_token', 'token', 'password', 'private_key', 'key_passphrase')
@guarded
@require_http_methods(['GET', 'POST'])
def mountpoints(request):
    if not request.user.is_superuser:
        raise PermissionDenied
    root_mount()
    editing = get_object_or_404(MountPoint, pk=request.GET['edit']) if request.GET.get('edit') else None
    provider = editing.provider if editing else request.POST.get('provider', request.GET.get('provider', 'local'))
    if provider not in PROVIDERS:
        raise ValidationError('Unknown provider.')
    action = request.POST.get('action', 'save')
    form = MountForm(request.POST if request.method == 'POST' and action == 'save' else None, provider=provider, mount=editing)
    if request.method == 'POST':
        if action in ('test', 'unmount'):
            mount = get_object_or_404(MountPoint, pk=request.POST.get('mount'))
            if action == 'test':
                mount_adapter(mount).probe()
                messages.success(request, f'{mount.path}: connection verified.')
            else:
                with transaction.atomic():
                    prefix = f'mount:{mount.pk}:'
                    if mount.path == '/' or mount.folder.children.exists() or mount.folder.documents.exists() or any(model.objects.filter(reference__startswith=prefix).exists() for model in (Document, Attachment, PendingDeletion)):
                        raise ValidationError('Move all contents out and finish pending cleanup before unmounting. The root mount cannot be removed.')
                    mount.delete()
                messages.success(request, 'Unmounted. The empty directory and provider files are retained.')
            return redirect('mountpoints')
        if action != 'save':
            raise ValidationError('Unknown action.')
        if form.is_valid():
            if provider == 'google' and not editing:
                from install import authorization_url
                state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(64)
                request.session['google_mount_oauth'] = encrypt({'state': state, 'verifier': verifier,
                    'created': time.time(), 'user': request.user.pk, 'path': form.cleaned_data['path'],
                    'history': form.cleaned_data['revision_history'], 'config': form.config, 'redirect_uri': google_callback_uri()})
                return redirect(authorization_url(form.config, google_callback_uri(), state, verifier))
            # Refresh tokens returned by a probe are included in the encrypted config.
            SafeAdapter(ADAPTERS[provider](form.config, lambda updated: form.config.update(updated))).probe()
            if editing:
                editing.revision_history = form.cleaned_data['revision_history']
                editing.encrypted_config = encrypt(form.config)
                editing.save(update_fields=['encrypted_config', 'revision_history'])
                if editing.path == '/':
                    Workspace.objects.filter(pk=1).update(encrypted_config=editing.encrypted_config)
                messages.success(request, 'Mount credentials updated and connection verified.')
            else:
                mounted = create_mount(request.user, form.cleaned_data['path'], form.config)
                mounted.revision_history = form.cleaned_data['revision_history']
                mounted.save(update_fields=['revision_history'])
                messages.success(request, 'Mount connected. Create or upload files in its directory.')
            return redirect('mountpoints')
    return render(request, 'wiki/mounts.html', {'mounts':MountPoint.objects.select_related('folder'),
        'google_callback_uri':google_callback_uri(), 'form':form, 'provider':provider, 'providers':PROVIDERS.items(), 'editing':editing, 'section':'Mountpoints'}, status=400 if form.errors else 200)


def google_callback_uri():
    return settings.PUBLIC_URL.rstrip('/') + reverse('google-mount-callback')


@sensitive_post_parameters('code')
@guarded
@require_http_methods(['GET', 'POST'])
def google_callback(request):
    # Google returns cross-site; Strict session cookies arrive only on the
    # same-origin confirmation POST. GET never connects a mount or exchanges tokens.
    if request.method == 'GET':
        return render(request, 'wiki/google_callback.html', {
            'code': request.GET.get('code', '')[:4096], 'state': request.GET.get('state', '')[:128],
            'oauth_error': bool(request.GET.get('error')),
        })
    if not request.user.is_authenticated or not request.user.is_superuser:
        raise PermissionDenied
    value = request.session.get('google_mount_oauth')
    if not value:
        raise ValidationError(_('Google authorization expired or was already used. Start again from Mountpoints.'))
    pending = decrypt(value)
    state = request.POST.get('state', '')
    if len(state) > 128 or not secrets.compare_digest(state, pending['state']) or pending['user'] != request.user.pk:
        raise PermissionDenied
    del request.session['google_mount_oauth']
    request.session.save()  # Consume before the network call, including failed attempts.
    if not 0 <= time.time() - pending['created'] <= 600:
        raise ValidationError(_('Google authorization expired or was already used. Start again from Mountpoints.'))
    code = request.POST.get('code', '')
    if not code or len(code) > 4096:
        raise ValidationError(_('Google authorization was cancelled. Start again from Mountpoints.'))
    from install import exchange_code
    config = pending['config']
    try:
        exchange_code(config, pending['redirect_uri'], code, pending['verifier'])
    except ValueError:
        raise ValidationError(_('Could not obtain a Google refresh token. Check the OAuth client and grant offline access, then try again.')) from None
    adapter = SafeAdapter(ADAPTERS['google'](config, lambda updated: config.update(updated)))
    if not config.get('root'):
        adapter.create_root(pending['path'].rsplit('/', 1)[-1])
    adapter.probe()
    mounted = create_mount(request.user, pending['path'], config)
    mounted.revision_history = pending.get('history')
    mounted.save(update_fields=['revision_history'])
    messages.success(request, _('Mount connected. Create or upload files in its directory.'))
    return redirect('mountpoints')
