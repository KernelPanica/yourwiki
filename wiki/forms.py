from django import forms
from django.utils.translation import gettext_lazy as _
from django.contrib.auth import get_user_model
from django.contrib.auth.forms import UserCreationForm
from django.contrib.auth.models import Group
from .models import Document, Folder

class RegistrationForm(UserCreationForm):
    display_name = forms.CharField(label=_('Display name'), max_length=150)
    class Meta:
        model = get_user_model()
        fields = ['username', 'display_name', 'password1', 'password2']

class CreationPermissions:
    """Use the same administrator boundary as the existing ACL editors."""
    def setup_permissions(self, user, *, editing=False, directory=False):
        self.permission_names = []
        if not user.is_superuser or editing:
            return
        from .models import SiteConfiguration, default_policy
        policy = default_policy() if directory else SiteConfiguration.current().default_document_policy
        self.fields['permissions_mode'] = forms.ChoiceField(
            label=_('Permissions'), required=False, initial='inherit',
            choices=[('inherit', _('Inherit from parent (workspace defaults at root)')),
                     ('custom', _('Set explicit permissions'))])
        self.permission_names.append('permissions_mode')
        self.permission_rows = []
        for scope, label in [('owner', _('Owner')), ('group', _('Primary group')), ('everyone', _('Everyone'))]:
            names = []
            for action in ('visible', 'read', 'write'):
                name = f'permission_{scope}_{action}'
                action_label = {'visible': _('Visible'), 'read': _('Read'), 'write': _('Write')}[action]
                self.fields[name] = forms.BooleanField(required=False, initial=policy[scope][action],
                    label=f'{label}: {action_label}', widget=forms.CheckboxInput(
                        attrs={'aria-label': f'{label}: {action_label}'}))
                self.permission_names.append(name)
                names.append(name)
            self.permission_rows.append((label, [self[name] for name in names]))
        self.permission_group_rows = []
        for group in Group.objects.order_by('name', 'pk'):
            prefix = f'permission_team_{group.pk}'
            enabled = prefix + '_enabled'
            self.fields[enabled] = forms.BooleanField(required=False, label=group.name,
                widget=forms.CheckboxInput(attrs={'data-group-permission-enabled': ''}))
            self.permission_names.append(enabled)
            names = []
            for action in ('visible', 'read', 'write'):
                name = prefix + '_' + action
                action_label = {'visible': _('Visible'), 'read': _('Read'), 'write': _('Write')}[action]
                self.fields[name] = forms.BooleanField(required=False, initial=action != 'write',
                    widget=forms.CheckboxInput(attrs={'aria-label': f'{group.name}: {action_label}',
                                                      'data-group-permission-rule': ''}))
                self.permission_names.append(name)
                names.append(name)
            self.permission_group_rows.append((group, self[enabled], [self[name] for name in names]))

    @property
    def main_fields(self):
        return [field for field in self if field.name not in self.permission_names]

    def creation_permissions(self):
        if not self.permission_names or self.cleaned_data.get('permissions_mode') != 'custom':
            return {}
        return {'inherit_permissions': False, 'group_policies': {
            str(group.pk): {action: self.cleaned_data[f'permission_team_{group.pk}_{action}']
                            for action in ('visible', 'read', 'write')}
            for group, enabled, _ in self.permission_group_rows
            if self.cleaned_data[enabled.name]}, 'policy': {
            scope: {action: self.cleaned_data[f'permission_{scope}_{action}']
                    for action in ('visible', 'read', 'write')}
            for scope in ('owner', 'group', 'everyone')}}

    def apply_permissions(self, item):
        values = self.creation_permissions()
        if values:
            for name, value in values.items():
                setattr(item, name, value)
            item.save(update_fields=list(values))


class DocumentForm(CreationPermissions, forms.Form):
    title = forms.CharField(label=_('Title'), max_length=200)
    kind = forms.ChoiceField(label=_('Kind'), choices=Document.KINDS)
    group = forms.ModelChoiceField(label=_('Group'), queryset=Group.objects.none())
    file_format = forms.ChoiceField(label=_('Text document format'), choices=[('docx', 'Word (.docx)'), ('md', 'Markdown (.md)')], initial='docx', required=False, help_text=_('Applies to text documents. Tables are stored as ODS.'))
    content = forms.CharField(label=_('Content'), widget=forms.Textarea(attrs={'rows': 22, 'spellcheck': 'false'}), required=False)
    revision = forms.IntegerField(widget=forms.HiddenInput, required=False)
    path = forms.CharField(label=_('Path'), initial='/', required=False, max_length=6500, help_text=_('Existing parent directory, e.g. /Projects/Notes. Use / for workspace root.'), widget=forms.TextInput(attrs={'list': 'directory-paths', 'placeholder': '/', 'aria-label': _('Path')}))
    folder = forms.ModelChoiceField(queryset=Folder.objects.none(), required=False, widget=forms.HiddenInput)

    def __init__(self, *args, user, editing=False, **kwargs):
        super().__init__(*args, **kwargs)
        self.user = user
        self.editing = editing
        self.setup_permissions(user, editing=editing)
        self.fields['kind'].choices = [(value, _(label)) for value, label in Document.KINDS]
        self.fields['group'].queryset = Group.objects.all() if user.is_superuser else user.groups.all()
        from .folders import accessible
        self.fields['folder'].queryset = Folder.objects.filter(pk__in=[f.pk for f in accessible(user, 'write')])
        from .folders import directory_path
        self.paths = [path for f in accessible(user, 'write') if (path := directory_path(f, user))]
        if not editing and self.initial.get('folder'):
            selected = self.fields['folder'].queryset.filter(pk=self.initial['folder']).first()
            self.initial['path'] = directory_path(selected, user) if selected else '/'
        if editing:
            self.fields['file_format'].disabled = True
            self.fields['kind'].disabled = True
            self.fields['group'].disabled = True
            self.fields['folder'].disabled = True
            self.fields['path'].widget = forms.HiddenInput()

    def clean(self):
        data = super().clean()
        if data.get('kind') != 'document':
            data['file_format'] = None
        if not self.editing and data.get('path'):
            from .folders import resolve_path
            try:
                data['folder'] = resolve_path(self.user, data['path'])
            except forms.ValidationError as error:
                self.add_error('path', error)
        return data


class DirectoryForm(CreationPermissions, forms.Form):
    permission_directory = True
    name = forms.CharField(label=_('Name'), max_length=200, widget=forms.TextInput(attrs={'autofocus': True, 'placeholder': _('New directory')}))
    path = forms.CharField(initial='/', max_length=6500, label=_('Parent path'), widget=forms.TextInput(attrs={'list': 'directory-paths'}))
    folder = forms.UUIDField(required=False, widget=forms.HiddenInput)

    def __init__(self, *args, user, **kwargs):
        super().__init__(*args, **kwargs)
        self.user = user
        self.setup_permissions(user, directory=self.permission_directory)
        if user.is_superuser:
            self.fields['group'] = forms.ModelChoiceField(label=_('Primary group'), queryset=Group.objects.all(),
                                                        required=False, initial=user.groups.first() or Group.objects.first())
        if self.initial.get('folder'):
            self.fields['path'].widget = forms.HiddenInput()
        from .folders import accessible, directory_path
        self.paths = [path for f in accessible(user, 'write') if (path := directory_path(f, user))]

    def clean_name(self):
        from .folders import validate_directory_name
        return validate_directory_name(self.cleaned_data['name'])

    def clean_path(self):
        from .folders import resolve_path
        if not self.data.get('folder'):
            resolve_path(self.user, self.cleaned_data['path'])
        return self.cleaned_data['path']


class UploadForm(DirectoryForm):
    permission_directory = False
    name = None
    file = forms.FileField(label=_('File'), allow_empty_file=True)

class InviteForm(forms.Form):
    days = forms.IntegerField(label=_('Expires in days (0 = never)'), min_value=0, max_value=3650, initial=7)
    max_uses = forms.IntegerField(label=_('Maximum uses (0 = unlimited)'), min_value=0, max_value=100000, initial=1)
    groups = forms.ModelMultipleChoiceField(label=_('Groups'), queryset=Group.objects.none(), required=False, widget=forms.CheckboxSelectMultiple)

    def __init__(self, *args, user, **kwargs):
        super().__init__(*args, **kwargs)
        from .models import SiteConfiguration
        config=SiteConfiguration.current()
        self.fields['days'].initial=config.invite_days
        self.fields['max_uses'].initial=config.invite_uses
        self.fields['groups'].queryset = Group.objects.all() if user.is_superuser else user.invite_groups.all()

class MemberForm(forms.Form):
    display_name = forms.CharField(label=_('Display name'), max_length=150)
    is_active = forms.BooleanField(required=False, label=_('Account enabled'))
    can_invite = forms.BooleanField(required=False, label=_('Can create invitations'))
    groups = forms.ModelMultipleChoiceField(label=_('Groups'), queryset=Group.objects.all(), required=False, widget=forms.CheckboxSelectMultiple)
    invite_groups = forms.ModelMultipleChoiceField(queryset=Group.objects.all(), required=False, widget=forms.CheckboxSelectMultiple, label=_('Groups this member may assign through invitations'))


class HistoryForm(forms.Form):
    revision_history = forms.TypedChoiceField(label=_('Revision history'),
        choices=[('', _('Inherit')), ('on', _('Enabled')), ('off', _('Disabled'))], required=False,
        coerce=lambda value: {'on': True, 'off': False}.get(value), empty_value=None)
