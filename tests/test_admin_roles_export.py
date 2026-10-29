from unittest.mock import Mock, patch
import pytest
from django.contrib.auth.models import Group
from django.core.exceptions import PermissionDenied
from django.core import signing
from wiki.models import User, Folder, TrashEntry, SiteConfiguration
from wiki.trash import trash_document, restore, purge, trash_user, trash_group
from wiki.acl import ResourcePermissionDenied
from wiki.services import save_document

pytestmark=pytest.mark.django_db


def simple(workspace):
    user=workspace['member'];user.is_simple_admin=True;user.save(update_fields=['is_simple_admin']);return user


def test_simple_admin_restores_but_cannot_purge_or_escalate(client,workspace,document):
    actor=simple(workspace)
    entry=trash_document(actor,document)
    with pytest.raises(ResourcePermissionDenied):purge(actor,entry)
    client.force_login(actor)
    response=client.post(f'/trash/{entry.pk}/',{'action':'purge','confirm':'on'})
    assert response.status_code==403
    assert TrashEntry.objects.filter(pk=entry.pk).exists()
    assert b'Permanent deletion' not in client.get(f'/trash/{entry.pk}/').content
    restore(actor,entry)
    assert client.get('/members/').status_code==200
    assert client.post(f'/members/{actor.pk}/',{'admin_role':'giga','display_name':'Escalation','is_active':'on'}).status_code==403
    assert client.post(f"/members/{workspace['admin'].pk}/",{'display_name':'Owned','is_active':'on'}).status_code==403
    actor.refresh_from_db();assert not actor.is_superuser


def test_giga_assigns_simple_role_and_user_trash_roundtrip(client,workspace):
    client.force_login(workspace['admin'])
    account=workspace['outsider']
    response=client.post(f'/members/{account.pk}/',{'display_name':'Delegate','is_active':'on','admin_role':'simple'})
    assert response.status_code==302
    account.refresh_from_db();assert account.is_simple_admin and not account.is_superuser
    account.is_simple_admin=False;account.save(update_fields=['is_simple_admin'])
    actor=simple(workspace)
    entry=trash_user(actor,account)
    account.refresh_from_db();assert not account.is_active
    with pytest.raises(ResourcePermissionDenied):purge(actor,entry)
    restore(actor,entry);account.refresh_from_db();assert account.is_active
    entry=trash_user(actor,account);purge(workspace['admin'],entry)
    assert not User.objects.filter(pk=account.pk).exists()


def test_group_trash_preserves_identity_files_and_memberships(workspace,document):
    actor=simple(workspace)
    group=document.group
    prior=set(group.user_set.values_list('pk',flat=True))
    entry=trash_group(actor,group)
    assert Group.objects.filter(pk=group.pk).exists()
    assert not group.user_set.exists()
    with pytest.raises(ResourcePermissionDenied):purge(actor,entry)
    restore(actor,entry)
    assert set(group.user_set.values_list('pk',flat=True))==prior
    document.refresh_from_db();assert document.group_id==group.pk


def test_export_restriction_inheritance_routes_and_ui(client,workspace,document):
    actor=simple(workspace)
    folder=Folder.objects.create(name='Restricted',owner=workspace['admin'],group=workspace['team'],export_disabled=True)
    document.folder=folder;document.save(update_fields=['folder'])
    assert not document.can_export(actor)
    assert document.can_export(workspace['admin'])
    client.force_login(actor)
    assert client.get(f'/documents/{document.pk}/export/').status_code==403
    assert client.get(f'/documents/{document.pk}/export/?inline=1').status_code==403
    assert client.get(f'/documents/{document.pk}/history/').status_code==403
    assert client.post(f'/api/docs/{document.pk}/recover',data='{"action":"copy"}',content_type='application/json').status_code==403
    assert b">Export</a>" not in client.get(f'/documents/{document.pk}/').content
    folder.export_disabled=False;folder.save(update_fields=['export_disabled'])
    config=SiteConfiguration.current();config.export_disabled=True;config.save()
    assert not document.can_export(actor)
    assert client.get(f'/documents/{document.pk}/export/').status_code==403


def test_collabora_export_flags_and_readonly_preview_token(workspace,settings,client):
    from wiki.collabora import open_session,token_for,SALT
    from urllib.parse import urlencode
    settings.COLLABORA_URL='https://office.example'
    actor=simple(workspace)
    document=save_document(workspace['admin'],'Restricted doc','document','Notes','Text',workspace['team'])
    document.export_disabled=True;document.save(update_fields=['export_disabled'])
    session=open_session(document,actor)
    token=token_for(session,actor,writable=False)
    assert signing.loads(token,salt=SALT)['write'] is False
    response=client.get(f'/wopi/files/{session.pk}?'+urlencode({'access_token':token}))
    assert response.status_code==200
    values=response.json()
    assert all(values[key] for key in ('DisableExport','HideExportOption','DisablePrint','DisableCopy','ReadOnly'))
    assert values['UserCanWrite'] is False


def test_archived_accounts_and_groups_cannot_bypass_trash(client,workspace):
    actor=simple(workspace)
    account=workspace['outsider']
    entry=trash_user(actor,account)
    client.force_login(actor)
    assert client.post(f'/members/{account.pk}/',{'display_name':'Restore bypass','is_active':'on'}).status_code==404
    account.refresh_from_db();assert not account.is_active
    group=Group.objects.create(name='Archived')
    trash_group(actor,group)
    assert client.post('/groups/',{'action':'create','name':'Archived'}).status_code==400
    from wiki.acl import validate_group_policies
    from django.core.exceptions import ValidationError
    with pytest.raises(ValidationError):validate_group_policies({str(group.pk):{'read':True,'write':True}})


def test_google_export_sync_confirms_and_restores_original(workspace,document):
    from wiki.export_restrictions import sync
    from wiki.models import ProviderExportRestriction,MountPoint
    mount=MountPoint.objects.get(path='/')
    mount.provider='google';mount.save(update_fields=['provider'])
    document.export_disabled=True;document.save(update_fields=['export_disabled'])
    original={'restrictedForReaders':True,'restrictedForWriters':False}
    remote=dict(original)
    adapter=Mock(base='https://drive.example/files')
    adapter.headers.return_value={}
    def request(method,url,**kwargs):
        if method=='PATCH':remote.update(kwargs['json']['downloadRestrictions']['itemDownloadRestriction'])
        return Mock(json=lambda:{'capabilities':{'canChangeItemDownloadRestriction':True},'downloadRestrictions':{'itemDownloadRestriction':dict(remote)}})
    adapter.request.side_effect=request
    with patch('wiki.export_restrictions.MountedStorage.reference',return_value=(mount,'file-id')),patch('wiki.export_restrictions.mount_adapter',return_value=adapter):
        sync()
        state=ProviderExportRestriction.objects.get(mount=mount,reference='file-id')
        assert state.applied is True and state.original==original and not state.error
        assert remote=={'restrictedForReaders':True,'restrictedForWriters':True}
        document.export_disabled=False;document.save(update_fields=['export_disabled'])
        sync()
        state.refresh_from_db();assert state.applied is False and not state.error
        assert remote==original


def test_presentation_embedded_view_is_readonly(client,workspace,settings):
    from wiki.collabora import SALT
    settings.COLLABORA_URL='https://office.example'
    settings.COLLABORA_WOPI_URL='https://wiki.example'
    document=save_document(workspace['admin'],'Slides','presentation','Notes','First slide',workspace['team'])
    client.force_login(workspace['admin'])
    with patch('wiki.collabora.editor_action',return_value='https://office.example/editor') as action:
        response=client.get(f'/documents/{document.pk}/office/?view=1&embed=1')
    assert response.status_code==200
    action.assert_called_once_with('pptx',False)
    assert signing.loads(response.context['office_token'],salt=SALT)['write'] is False
    assert response.context['office_bootstrap']['write'] is False
    assert response['X-Frame-Options']=='SAMEORIGIN'


def test_invitation_trash_roundtrip_and_purge_role(workspace):
    from wiki.models import Invitation
    from wiki.trash import trash_invitation
    invitation=Invitation.objects.create(token_hash='test-trash-token',creator=workspace['admin'],max_uses=1)
    actor=simple(workspace)
    entry=trash_invitation(actor,invitation)
    invitation.refresh_from_db();assert invitation.revoked
    with pytest.raises(ResourcePermissionDenied):purge(actor,entry)
    restore(actor,entry)
    invitation.refresh_from_db();assert not invitation.revoked
    entry=trash_invitation(actor,invitation);purge(workspace['admin'],entry)
    assert not Invitation.objects.filter(pk=invitation.pk).exists()
