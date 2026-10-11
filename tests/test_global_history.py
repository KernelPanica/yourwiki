import itertools
import json
import pytest
from wiki.models import Folder, SiteConfiguration
from wiki.storage import active_storage, root_mount
from wiki.services import save_document

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize('global_enabled', [False, True])
@pytest.mark.parametrize('local,folder,mount', list(itertools.product([None,False,True],repeat=3)))
def test_global_history_ignores_every_legacy_override(workspace, document, global_enabled, local, folder, mount):
    SiteConfiguration.objects.update_or_create(pk=1,defaults={'revision_history':global_enabled})
    parent = Folder.objects.create(name='Parent',owner=workspace['admin'],group=workspace['team'],revision_history=folder)
    document.folder, document.revision_history = parent, local
    root = root_mount()
    root.revision_history = mount
    root.save(update_fields=['revision_history'])
    assert document.history_enabled() is global_enabled
    assert parent.history_enabled() is global_enabled


def test_default_off_and_disabling_preserves_existing_history(client, workspace, document):
    document.revision_history = True
    document.save()
    assert not document.history_enabled()
    user,team = workspace['admin'],workspace['team']
    document = save_document(user,document.title,'document','Notes','Second',team,document,document.revision)
    assert not document.history_reference
    SiteConfiguration.objects.update_or_create(pk=1,defaults={'revision_history':True})
    document = save_document(user,document.title,'document','Notes','Third',team,document,document.revision)
    reference = document.history_reference
    original = active_storage().read(reference)
    assert len(json.loads(original)['entries']) == 1
    SiteConfiguration.objects.filter(pk=1).update(revision_history=False)
    document = save_document(user,document.title,'document','Notes','Fourth',team,document,document.revision)
    assert document.history_reference == reference
    assert active_storage().read(reference) == original
    from django.urls import reverse
    client.force_login(user)
    response = client.get(reverse('file-history',args=[document.pk]))
    assert response.status_code == 200
    assert response.content == original


def test_resource_settings_cannot_mutate_legacy_history_flags(client,workspace,document):
    from django.urls import reverse
    folder = Folder.objects.create(name='Parent',owner=workspace['admin'],group=workspace['team'],revision_history=True)
    document.revision_history = True
    document.save()
    client.force_login(workspace['admin'])
    for target,url in [(document,reverse('file-settings',args=[document.pk])),(folder,reverse('folder_settings',args=[folder.pk]))]:
        response = client.get(url)
        assert response.status_code == 200
        assert b'name="revision_history"' not in response.content
        assert client.post(url,{'revision_history':'off'}).status_code == 400
        target.refresh_from_db()
        assert target.revision_history is True


def test_mount_form_has_no_history_control_and_ignores_legacy_input(workspace):
    from wiki.mounts import MountForm
    form = MountForm({'path':'/Archive','root':str(workspace['root']),'revision_history':'on'},provider='local')
    assert 'revision_history' not in form.fields
    assert form.is_valid(),form.errors
    assert form.cleaned_data['revision_history'] is None


def test_mount_credential_edit_preserves_legacy_override(client,workspace):
    from django.urls import reverse
    from unittest.mock import patch
    from wiki.storage import Local
    mount = root_mount()
    mount.revision_history = True
    mount.save(update_fields=['revision_history'])
    client.force_login(workspace['admin'])
    with patch.object(Local,'probe',return_value=None):
        response = client.post(reverse('mountpoints')+f'?edit={mount.pk}',{
            'provider':'local','path':'/','root':str(workspace['root']),'revision_history':'off'})
    assert response.status_code == 302
    mount.refresh_from_db()
    assert mount.revision_history is True
    assert not SiteConfiguration.current().revision_history


def test_administrator_can_toggle_global_history_and_member_cannot(client, workspace, document):
    from django.urls import reverse
    url = reverse('settings')
    client.force_login(workspace['admin'])
    response = client.get(url)
    assert response.status_code == 200
    assert b'name="revision_history"' in response.content
    payload = dict(response.context['form'].initial)
    payload['revision_history'] = 'on'
    assert client.post(url, payload).status_code == 302
    assert document.history_enabled()
    client.force_login(workspace['member'])
    assert client.post(url, payload).status_code == 500  # Site-wide deny contract.
    assert document.history_enabled()
    client.force_login(workspace['admin'])
    payload.pop('revision_history')
    assert client.post(url, payload).status_code == 302
    assert not document.history_enabled()
