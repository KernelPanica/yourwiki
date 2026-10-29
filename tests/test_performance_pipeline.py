from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock,patch
import pytest
from wiki.storage import GoogleDrive,StorageError


def test_oauth_refresh_is_reused_and_rotated_token_is_saved():
    persisted=Mock()
    adapter=GoogleDrive({'provider':'google','client_id':'client','client_secret':'secret','refresh_token':'old'},persisted)
    adapter.request=Mock(return_value=Mock(json=lambda:{'access_token':'access','refresh_token':'new','expires_in':3600}))
    with patch('wiki.storage.time.monotonic',return_value=100):
        assert adapter.headers()==adapter.headers()=={'Authorization':'Bearer access'}
    assert adapter.request.call_count==1
    persisted.assert_called_once();assert adapter.config['refresh_token']=='new'
    with patch('wiki.storage.time.monotonic',return_value=3700):adapter.headers()
    assert adapter.request.call_count==2


def test_concurrent_oauth_requests_share_refresh():
    adapter=GoogleDrive({'provider':'google','client_id':'client','client_secret':'secret','refresh_token':'old'})
    adapter.request=Mock(return_value=Mock(json=lambda:{'access_token':'access','expires_in':3600}))
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert list(pool.map(lambda _:adapter.headers(),range(20)))==[{'Authorization':'Bearer access'}]*20
    assert adapter.request.call_count==1


def test_failed_oauth_refresh_retries_and_short_lived_token_is_not_extended():
    adapter=GoogleDrive({'provider':'google','client_id':'client','client_secret':'secret','refresh_token':'old'})
    adapter.request=Mock(side_effect=[StorageError('unavailable'),Mock(json=lambda:{'access_token':'access','expires_in':1})])
    with pytest.raises(StorageError):adapter.headers()
    with patch('wiki.storage.time.monotonic',return_value=100):assert adapter.headers()['Authorization']=='Bearer access'
    adapter.request.return_value=Mock(json=lambda:{'access_token':'fresh','expires_in':3600});adapter.request.side_effect=None
    with patch('wiki.storage.time.monotonic',return_value=102):assert adapter.headers()['Authorization']=='Bearer fresh'


@pytest.mark.django_db
def test_permission_action_enqueues_without_network(workspace,document,django_capture_on_commit_callbacks):
    from wiki.models import ProviderSyncState
    with patch('wiki.provider_grants.reconcile') as remote:
        with django_capture_on_commit_callbacks(execute=True):
            document.user_policies={str(workspace['member'].pk):{'read':True,'write':True}}
            document.save(update_fields=['user_policies'])
    remote.assert_not_called()
    assert ProviderSyncState.objects.get(pk=1).pending


@pytest.mark.django_db(transaction=True)
def test_permission_worker_preserves_new_requests_and_retries(workspace):
    from wiki.provider_grants import enqueue_sync,process_pending
    from wiki.models import ProviderSyncState
    enqueue_sync()
    with patch('wiki.provider_grants.reconcile',side_effect=lambda **kwargs:enqueue_sync()):assert process_pending()
    state=ProviderSyncState.objects.get(pk=1);assert state.pending
    with patch('wiki.provider_grants.reconcile',side_effect=RuntimeError('network failed')):assert not process_pending()
    state.refresh_from_db();assert state.pending and state.error
    with patch('wiki.provider_grants.reconcile') as remote:
        assert not process_pending();remote.assert_not_called()
        assert process_pending(retry=True)
    state.refresh_from_db();assert not state.pending and not state.error


@pytest.mark.django_db
def test_preview_cache_avoids_remote_reads_but_not_pending_edits(workspace,document):
    from wiki.collaboration import current_content,ensure_room
    from wiki.preview_cache import clear
    from wiki.storage import active_storage
    clear()
    adapter=active_storage()
    original=adapter.read
    with patch('wiki.collaboration.active_storage',return_value=adapter),patch.object(adapter,'read',wraps=original) as read:
        assert current_content(document,cached=True)==current_content(document,cached=True)
        assert read.call_count==1
        current_content(document)
        assert read.call_count==2
        document.revision+=1;document.save(update_fields=['revision'])
        current_content(document,cached=True);assert read.call_count==3
    room=ensure_room(document);room.snapshot='Unsaved edits';room.sequence+=1;room.save()
    assert current_content(document,cached=True)=='Unsaved edits'


def test_preview_cache_single_flight_expiry_and_error_retry():
    from wiki.preview_cache import clear,content
    document=Mock(pk='cache-test',reference='ref',storage_digest='digest',revision=1,file_format='md',format_version=1)
    clear();load=Mock(return_value='Preview')
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert list(pool.map(lambda _:content(document,load),range(10)))==['Preview']*10
    assert load.call_count==1
    with patch('wiki.preview_cache.time.monotonic',return_value=10**20):assert content(document,load)=='Preview'
    assert load.call_count==2
    clear();load.side_effect=StorageError('offline')
    with pytest.raises(StorageError):content(document,load)
    load.side_effect=None;assert content(document,load)=='Preview'


@pytest.mark.django_db
def test_native_and_office_open_read_without_write_transaction(workspace,document,settings):
    from django.db import connection
    from wiki.collaboration import ensure_room,current_content
    from wiki.collabora import open_session
    from wiki.storage import active_storage
    settings.COLLABORA_URL='https://office.example'
    adapter=active_storage();original=adapter.read
    # pytest uses an outer test transaction; record whether these functions add
    # an inner transaction around remote I/O.
    depth=len(connection.savepoint_ids)
    def read(*args,**kwargs):
        assert len(connection.savepoint_ids)==depth
        return original(*args,**kwargs)
    with patch.object(adapter,'read',side_effect=read),patch('wiki.collaboration.active_storage',return_value=adapter):
        current_content(document)
        ensure_room(document)
    from wiki.models import Collaboration
    Collaboration.objects.filter(document=document).delete()
    with patch.object(adapter,'read',side_effect=read),patch('wiki.collabora.active_storage',return_value=adapter):
        open_session(document,workspace['admin'])


def test_only_content_hashed_assets_are_cached_immutably():
    from wiki.static_headers import add_headers
    headers={};add_headers(headers,'','/static/wiki/dist/chunk-ABCDEFG1.js')
    assert 'immutable' in headers['Cache-Control']
    headers={};add_headers(headers,'','/static/wiki/office.js')
    assert 'Cache-Control' not in headers


@pytest.mark.django_db
def test_reopening_unchanged_native_editor_does_not_rebuild_crdt(document):
    from wiki.collaboration import ensure_room
    room=ensure_room(document)
    with patch('wiki.collaboration.seed') as seed:
        assert ensure_room(document).pk==room.pk
    seed.assert_not_called()


@pytest.mark.django_db(transaction=True)
def test_forced_reconciliation_stays_durable(workspace):
    from wiki.provider_grants import enqueue_sync,process_pending
    from wiki.models import ProviderSyncState
    enqueue_sync(force=True)
    state=ProviderSyncState.objects.get(pk=1);assert state.force_revision==state.requested_revision
    with patch('wiki.provider_grants.reconcile') as reconcile:
        assert process_pending()
        reconcile.assert_called_once_with(force=True)


@pytest.mark.django_db
def test_cached_preview_does_not_cache_permissions(client,workspace,document):
    client.force_login(workspace['member'])
    assert client.get(f'/documents/{document.pk}/').status_code==200
    workspace['member'].groups.clear()
    assert client.get(f'/documents/{document.pk}/').status_code==404


@pytest.mark.django_db
def test_uploaded_office_preview_does_not_download_for_image_detection(client,workspace,settings):
    from wiki.models import Document
    settings.COLLABORA_URL='https://office.example'
    document=Document.objects.create(title='Uploaded.pptx',kind='file',owner=workspace['admin'],group=workspace['team'],reference='presentation.pptx')
    client.force_login(workspace['admin'])
    with patch('wiki.views.active_storage') as storage:
        response=client.get(f'/documents/{document.pk}/')
    assert response.status_code==200
    storage.return_value.read.assert_not_called()
