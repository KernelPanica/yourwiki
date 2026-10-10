import pytest
from unittest.mock import Mock
from wiki.models import ProviderIdentity, ProviderGrant, MountPoint
from wiki.crypto import encrypt

@pytest.fixture
def remote(document, workspace, monkeypatch):
    mount = MountPoint.objects.create(path='/remote',provider='google',encrypted_config=encrypt({'provider':'google','root':'root'}))
    document.reference=f'mount:{mount.pk}:file1'; document.save(update_fields=['reference'])
    adapter=Mock(); adapter.set_grant.return_value='permission1'
    monkeypatch.setattr('wiki.provider_grants.mount_adapter',lambda m:adapter)
    return document,mount,adapter

def test_grant_read_write_and_revoke(remote,workspace):
    from wiki.provider_grants import sync_provider_grants
    doc,mount,adapter=remote
    ProviderIdentity.objects.create(user=workspace['member'],provider='google',external_id='subject',email='member@example.org')
    sync_provider_grants()
    grant=ProviderGrant.objects.get(user=workspace['member'],mount=mount)
    assert grant.applied_role=='read' and grant.status=='synced'
    doc.policy['group']['write']=True;doc.save()
    sync_provider_grants();grant.refresh_from_db();assert grant.applied_role=='write'
    workspace['member'].groups.clear()
    sync_provider_grants();grant.refresh_from_db()
    assert grant.status=='revoked' and not grant.applied_role
    adapter.revoke_grant.assert_called_with('file1','member@example.org','permission1')

def test_failure_preserves_acl_and_retries(remote,workspace):
    from wiki.provider_grants import sync_provider_grants
    doc,mount,adapter=remote
    ProviderIdentity.objects.create(user=workspace['member'],provider='google',external_id='subject',email='member@example.org')
    adapter.set_grant.side_effect=RuntimeError('secret token')
    sync_provider_grants()
    grant=ProviderGrant.objects.get(user=workspace['member'],mount=mount)
    assert grant.status=='failed' and 'secret' not in grant.error
    assert doc.allows(workspace['member'],'read')
    adapter.set_grant.side_effect=None
    sync_provider_grants();grant.refresh_from_db();assert grant.status=='synced'

def test_missing_identity_pending_and_unlink_revokes(remote,workspace):
    from wiki.provider_grants import sync_provider_grants
    doc,mount,adapter=remote
    sync_provider_grants()
    grant=ProviderGrant.objects.get(user=workspace['member'],mount=mount)
    assert grant.status=='pending';adapter.set_grant.assert_not_called()
    identity=ProviderIdentity.objects.create(user=workspace['member'],provider='google',external_id='subject',email='member@example.org')
    sync_provider_grants()
    identity.active=False;identity.save()
    sync_provider_grants();grant.refresh_from_db()
    assert not grant.applied_role
    adapter.revoke_grant.assert_called_once()

def test_deleted_document_revoke(remote,workspace):
    from wiki.provider_grants import sync_provider_grants
    doc,mount,adapter=remote
    ProviderIdentity.objects.create(user=workspace['member'],provider='google',external_id='subject',email='member@example.org')
    sync_provider_grants();doc.delete();sync_provider_grants()
    assert ProviderGrant.objects.get(user=workspace['member'],mount=mount).status=='revoked'

def test_identity_change_revokes_old_before_new(remote,workspace):
    from wiki.provider_grants import sync_provider_grants
    doc,mount,adapter=remote
    identity=ProviderIdentity.objects.create(user=workspace['member'],provider='google',external_id='a',email='first@example.org')
    sync_provider_grants();adapter.reset_mock()
    identity.email='second@example.org';identity.save()
    sync_provider_grants()
    names=[call[0] for call in adapter.mock_calls]
    assert names.index('revoke_grant')<names.index('set_grant')
    adapter.revoke_grant.assert_called_with('file1','first@example.org','permission1')

def test_failed_revoke_retains_receipt_and_retry(remote,workspace):
    from wiki.provider_grants import sync_provider_grants
    doc,mount,adapter=remote
    identity=ProviderIdentity.objects.create(user=workspace['member'],provider='google',external_id='a',email='first@example.org')
    sync_provider_grants()
    identity.active=False;identity.save()
    adapter.revoke_grant.side_effect=RuntimeError('secret')
    sync_provider_grants()
    grant=ProviderGrant.objects.get(user=workspace['member'],mount=mount)
    assert grant.status=='failed' and grant.recipient=='first@example.org' and grant.permission_id=='permission1'
    adapter.revoke_grant.side_effect=None
    sync_provider_grants();grant.refresh_from_db();assert not grant.recipient

def test_repository_role_aggregates_all_paths(document,workspace,monkeypatch):
    from wiki.provider_grants import sync_provider_grants
    from wiki.models import Document
    mount=MountPoint.objects.create(path='/git',provider='github',encrypted_config=encrypt({'repository':'owner/repo'}))
    second=MountPoint.objects.create(path='/another-git',provider='github',encrypted_config=encrypt({'repository':'owner/repo'}))
    document.reference=f'mount:{mount.pk}:one.md';document.policy['group']['write']=True;document.save()
    other=Document.objects.get(pk=document.pk);other.pk=None;other.reference=f'mount:{second.pk}:two.md';other.policy['group']['write']=False;other.save()
    ProviderIdentity.objects.create(user=workspace['member'],provider='github',external_id='123',login='member')
    adapter=Mock();adapter.set_grant.return_value='collaborator:member'
    monkeypatch.setattr('wiki.provider_grants.mount_adapter',lambda m:adapter)
    sync_provider_grants()
    grant=ProviderGrant.objects.get(user=workspace['member']);assert grant.applied_role=='write'
    document.delete();sync_provider_grants();grant.refresh_from_db();assert grant.applied_role=='read'
    assert ProviderGrant.objects.filter(user=workspace['member']).count()==1

def test_acl_commits_trigger_sync(remote,workspace,django_capture_on_commit_callbacks):
    from wiki.provider_grants import sync_provider_grants
    doc,mount,adapter=remote
    ProviderIdentity.objects.create(user=workspace['member'],provider='google',external_id='a',email='member@example.org')
    sync_provider_grants()
    with django_capture_on_commit_callbacks(execute=True):
        workspace['member'].groups.clear()
    assert ProviderGrant.objects.get(user=workspace['member'],mount=mount).status=='revoked'

def test_all_deleted_user_receipts_are_retried(remote,workspace):
    from wiki.provider_grants import sync_provider_grants
    doc,mount,adapter=remote
    for user in [workspace['member'],workspace['outsider']]:
        user.groups.add(workspace['team'])
        ProviderIdentity.objects.create(user=user,provider='google',external_id=user.username,email=user.username+'@example.org')
    sync_provider_grants()
    adapter.revoke_grant.side_effect=RuntimeError('offline')
    workspace['member'].delete();workspace['outsider'].delete();sync_provider_grants()
    adapter.revoke_grant.side_effect=None;adapter.reset_mock()
    sync_provider_grants()
    assert ProviderGrant.objects.filter(user=None).count()==2
    assert not ProviderGrant.objects.filter(user=None).exclude(status='revoked').exists()
    assert adapter.revoke_grant.call_count==2

def test_onedrive_same_item_across_roots_uses_drive_identity(document,workspace,monkeypatch):
    from wiki.provider_grants import sync_provider_grants
    from wiki.models import Document
    mount=MountPoint.objects.create(path='/drive',provider='onedrive',encrypted_config=encrypt({'root':'folder1'}))
    second=MountPoint.objects.create(path='/other',provider='onedrive',encrypted_config=encrypt({'root':'folder2'}))
    document.reference=f'mount:{mount.pk}:item';document.policy['group']['write']=True;document.save()
    other=Document.objects.get(pk=document.pk);other.pk=None;other.reference=f'mount:{second.pk}:item';other.policy['group']['write']=False;other.save()
    ProviderIdentity.objects.create(user=workspace['member'],provider='onedrive',external_id='123',email='member@example.org')
    adapter=Mock();adapter.set_grant.return_value='p';adapter.drive_id.return_value='drive123'
    monkeypatch.setattr('wiki.provider_grants.mount_adapter',lambda m:adapter)
    sync_provider_grants();assert ProviderGrant.objects.filter(user=workspace['member']).count()==1
    document.delete();sync_provider_grants()
    grant=ProviderGrant.objects.get(user=workspace['member']);assert grant.applied_role=='read'
    adapter.revoke_grant.assert_not_called()

def test_onedrive_missing_namespace_is_resolved(document,workspace,monkeypatch):
    from wiki.provider_grants import target
    mount=MountPoint.objects.create(path='/drive',provider='onedrive',encrypted_config=encrypt({'root':'folder1'}))
    adapter=Mock();adapter.drive_id.return_value='drive123'
    monkeypatch.setattr('wiki.provider_grants.mount_adapter',lambda m:adapter)
    resolved=target(mount,'item',resolve=True)
    mount.encrypted_config=encrypt({'root':'folder2','drive_id':'drive123'})
    assert resolved==target(mount,'item')

def test_content_metadata_does_not_resync_all_grants(document,monkeypatch,django_capture_on_commit_callbacks):
    sync=Mock();monkeypatch.setattr('wiki.provider_grants.sync_provider_grants',sync)
    with django_capture_on_commit_callbacks(execute=True):
        document.title='Renamed without changing provider identity';document.revision+=1;document.save()
    sync.assert_not_called()
    with django_capture_on_commit_callbacks(execute=True):
        document.policy['group']['write']=True;document.save()
    sync.assert_called_once()

def test_account_grants_do_not_reveal_unreadable_files(remote,workspace,client):
    from wiki.provider_grants import sync_provider_grants
    doc,mount,adapter=remote
    ProviderIdentity.objects.create(user=workspace['member'],provider='google',external_id='a',email='member@example.org')
    sync_provider_grants()
    client.force_login(workspace['member'])
    response=client.get('/account/providers/')
    assert response.status_code==200 and doc.title in response.content.decode()
    workspace['member'].groups.clear()
    # Simulate a delayed grant callback: the local ACL must hide the resource now.
    response=client.get('/account/providers/')
    assert response.status_code==200 and doc.title not in response.content.decode()

def test_autosave_unchanged_reference_does_not_reconcile_grants(document,monkeypatch,django_capture_on_commit_callbacks):
    sync=Mock();monkeypatch.setattr('wiki.provider_grants.sync_provider_grants',sync)
    with django_capture_on_commit_callbacks(execute=True):
        document.revision+=1;document.save(update_fields=['revision','reference','storage_digest'])
    sync.assert_not_called()
    with django_capture_on_commit_callbacks(execute=True):
        document.reference='new-reference';document.save(update_fields=['reference'])
    sync.assert_called_once()
