import pytest
from wiki.saves import stage, commit
from wiki.storage import active_storage, StorageError
from wiki.models import SaveSession

pytestmark = pytest.mark.django_db


def test_lost_provider_ack_is_reconciled_without_second_write(document, workspace, monkeypatch):
    adapter = active_storage()
    original = adapter.write
    calls = []
    def lost_ack(*args, **kwargs):
        calls.append(args)
        original(*args, **kwargs)
        raise StorageError('Connection lost after provider commit')
    monkeypatch.setattr(adapter, 'write', lost_ack)
    session = stage(document, workspace['admin'], '# Confirm me', 'recovery-tab', document.revision)
    with pytest.raises(StorageError):
        commit(session.pk, adapter=adapter)
    session.refresh_from_db()
    assert session.state == 'unknown'
    assert bytes(session.payload) == b'# Confirm me'
    monkeypatch.setattr(adapter, 'write', original)
    saved = commit(session.pk, adapter=adapter)
    session.refresh_from_db()
    assert session.state == 'saved' and len(calls) == 1
    assert saved.storage_digest == adapter.fingerprint(saved.reference, adapter.read(saved.reference))


def test_unknown_outcome_never_replays_over_an_external_edit(document, workspace, monkeypatch):
    adapter = active_storage()
    original = adapter.write
    def lost_ack(*args, **kwargs):
        original(*args, **kwargs)
        raise StorageError('lost')
    monkeypatch.setattr(adapter, 'write', lost_ack)
    session = stage(document, workspace['admin'], '# Our edit', 'recovery-tab', document.revision)
    with pytest.raises(StorageError): commit(session.pk, adapter=adapter)
    original('unused', b'External edit', document.reference)
    from wiki.services import Conflict
    with pytest.raises(Conflict): commit(session.pk, adapter=adapter)
    assert adapter.read(document.reference) == b'External edit'


def test_newer_edits_after_lost_ack_are_written_against_confirmed_base(document, workspace, monkeypatch):
    adapter = active_storage()
    original = adapter.write
    def lost_ack(*args, **kwargs):
        original(*args, **kwargs)
        raise StorageError('lost')
    monkeypatch.setattr(adapter, 'write', lost_ack)
    session = stage(document, workspace['admin'], '# First', 'recovery-tab', document.revision)
    with pytest.raises(StorageError): commit(session.pk, adapter=adapter)
    # A fresh adapter has none of the original process's in-memory receipts.
    session = stage(document, workspace['admin'], '# Newer', 'recovery-tab', document.revision)
    saved = commit(session.pk, adapter=active_storage())
    assert active_storage().read(saved.reference) == b'# Newer'


def test_unknown_write_keeps_created_history_for_reconciliation(document, workspace, monkeypatch):
    from wiki.models import SiteConfiguration
    SiteConfiguration.objects.update_or_create(pk=1, defaults={'revision_history':True})
    adapter = active_storage()
    original = adapter.write
    def unavailable(key, *args, **kwargs):
        if key.endswith('.md'): raise StorageError('unknown')
        return original(key, *args, **kwargs)
    monkeypatch.setattr(adapter, 'write', unavailable)
    session = stage(document, workspace['admin'], '# New', 'recovery-tab', document.revision)
    with pytest.raises(StorageError): commit(session.pk, adapter=adapter)
    saved = commit(session.pk, adapter=active_storage())
    import json
    history = json.loads(active_storage().read(saved.history_reference))
    assert len(history['entries']) == 1
    assert history['entries'][0]['author']['id'] == workspace['admin'].pk


def test_lost_rename_response_restores_path_identity(document, workspace, monkeypatch):
    from wiki.services import save_document
    adapter=active_storage()
    original=adapter.move
    raw=adapter.read(document.reference)
    def lost_move(*args):
        original(*args)
        raise StorageError('lost rename acknowledgement')
    monkeypatch.setattr(adapter,'move',lost_move)
    monkeypatch.setattr('wiki.services.active_storage',lambda:adapter)
    with pytest.raises(StorageError):
        save_document(workspace['admin'],'Renamed','document',document.collection,raw.decode(),document.group,document,document.revision)
    monkeypatch.setattr(adapter,'move',original)
    document.refresh_from_db()
    saved=save_document(workspace['admin'],'Renamed','document',document.collection,raw.decode(),document.group,document,document.revision)
    assert saved.reference.endswith('Renamed.md')
    assert adapter.read(saved.reference)==raw


def test_rename_only_sql_rollback_keeps_recovery_reference(document, workspace, monkeypatch):
    from wiki.services import save_document
    from wiki.models import Document
    raw=active_storage().read(document.reference)
    original=Document.save
    def failed_receipt(self,*args,**kwargs):
        if self.reference.endswith('Renamed.md'): raise RuntimeError('SQL receipt failed')
        return original(self,*args,**kwargs)
    monkeypatch.setattr(Document,'save',failed_receipt)
    with pytest.raises(RuntimeError):
        save_document(workspace['admin'],'Renamed','document',document.collection,raw.decode(),document.group,document,document.revision)
    monkeypatch.setattr(Document,'save',original)
    document.refresh_from_db()
    saved=save_document(workspace['admin'],'Renamed','document',document.collection,raw.decode(),document.group,document,document.revision)
    assert active_storage().read(saved.reference)==raw


def test_failed_rename_never_binds_to_identical_unrelated_target(document, workspace):
    from wiki.services import save_document
    adapter=active_storage()
    raw=adapter.read(document.reference)
    unrelated=adapter.write('Collision.md',raw)
    with pytest.raises(StorageError):
        save_document(workspace['admin'],'Collision','document',document.collection,raw.decode(),document.group,document,document.revision)
    document.refresh_from_db()
    original=document.reference
    saved=save_document(workspace['admin'],document.title,'document',document.collection,'Changed original',document.group,document,document.revision)
    assert saved.reference==original
    assert adapter.read(unrelated)==raw


def test_creation_reference_survives_fingerprint_failure(document, workspace, monkeypatch):
    from wiki.file_history import persist
    from wiki.write_journal import _load
    adapter=active_storage()
    original=adapter.fingerprint
    def unavailable(*args): raise StorageError('fingerprint unavailable')
    monkeypatch.setattr(adapter,'fingerprint',unavailable)
    with pytest.raises(StorageError):
        persist(document,'# Created','Created.md',new=True,adapter=adapter)
    assert _load(document)[1]['reference']=='Created.md'
    monkeypatch.setattr(adapter,'fingerprint',original)
    assert persist(document,'# Created','Created.md',new=True,adapter=adapter)=='Created.md'
