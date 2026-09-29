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

class DocumentForm(forms.Form):
    title = forms.CharField(label=_('Title'), max_length=200)
    kind = forms.ChoiceField(label=_('Kind'), choices=Document.KINDS)
    group = forms.ModelChoiceField(label=_('Group'), queryset=Group.objects.none())
    content = forms.CharField(label=_('Content'), widget=forms.Textarea(attrs={'rows': 22, 'spellcheck': 'false'}), required=False)
    revision = forms.IntegerField(widget=forms.HiddenInput, required=False)
    path = forms.CharField(label=_('Path'), initial='/', required=False, max_length=6500, help_text=_('Existing parent directory, e.g. /Projects/Notes. Use / for workspace root.'), widget=forms.TextInput(attrs={'list': 'directory-paths', 'placeholder': '/', 'aria-label': _('Path')}))
    folder = forms.ModelChoiceField(queryset=Folder.objects.none(), required=False, widget=forms.HiddenInput)

    def __init__(self, *args, user, editing=False, **kwargs):
        super().__init__(*args, **kwargs)
        self.user = user
        self.editing = editing
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
            self.fields['kind'].disabled = True
            self.fields['group'].disabled = True
            self.fields['folder'].disabled = True
            self.fields['path'].widget = forms.HiddenInput()

    def clean(self):
        data = super().clean()
        if not self.editing and data.get('path'):
            from .folders import resolve_path
            try:
                data['folder'] = resolve_path(self.user, data['path'])
            except forms.ValidationError as error:
                self.add_error('path', error)
        return data


class DirectoryForm(forms.Form):
    name = forms.CharField(label=_('Name'), max_length=200, widget=forms.TextInput(attrs={'autofocus': True, 'placeholder': _('New directory')}))
    path = forms.CharField(initial='/', max_length=6500, label=_('Parent path'), widget=forms.TextInput(attrs={'list': 'directory-paths'}))
    folder = forms.UUIDField(required=False, widget=forms.HiddenInput)

    def __init__(self, *args, user, **kwargs):
        super().__init__(*args, **kwargs)
        self.user = user
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
