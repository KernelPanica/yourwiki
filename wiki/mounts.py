"""Administrator-managed mountpoints in the shared filesystem namespace."""
from pathlib import Path
from django import forms
from django.contrib import messages
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_http_methods
from .crypto import decrypt, encrypt
from .models import Attachment, Document, Folder, MountPoint, PendingDeletion, Workspace
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


class MountForm(forms.Form):
    path = forms.CharField(label='Mount path', max_length=2048, help_text='Absolute path, for example /projects/archive. Missing parent directories are created.')

    def __init__(self, *args, provider='local', mount=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.provider, self.mount = provider, mount
        self.old = decrypt(mount.encrypted_config) if mount else {}
        if mount:
            self.fields['path'].initial = mount.path
            self.fields['path'].disabled = True
        for name in FIELDS[provider]:
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
        from install import validate_config
        if self.provider == 'onedrive':
            config['tenant'] = config.get('tenant') or 'common'
        try:
            validate_config(config)
            if self.provider in ('google','onedrive') and not all(config.get(name) for name in ('root', 'refresh_token')):
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
            # Refresh tokens returned by a probe are included in the encrypted config.
            SafeAdapter(ADAPTERS[provider](form.config, lambda updated: form.config.update(updated))).probe()
            if editing:
                editing.encrypted_config = encrypt(form.config)
                editing.save(update_fields=['encrypted_config'])
                if editing.path == '/':
                    Workspace.objects.filter(pk=1).update(encrypted_config=editing.encrypted_config)
                messages.success(request, 'Mount credentials updated and connection verified.')
            else:
                create_mount(request.user, form.cleaned_data['path'], form.config)
                messages.success(request, 'Mount connected. Create or upload files in its directory.')
            return redirect('mountpoints')
    return render(request, 'wiki/mounts.html', {'mounts':MountPoint.objects.select_related('folder'),
        'form':form, 'provider':provider, 'providers':PROVIDERS.items(), 'editing':editing, 'section':'Mountpoints'}, status=400 if form.errors else 200)
