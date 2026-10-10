from unittest.mock import Mock
import pytest

from django.core.files.uploadedfile import SimpleUploadedFile

from tests.test_pdf_ai import sample_pdf
from wiki.services import save_document
from wiki.storage import active_storage


def pdf_document(workspace):
    return save_document(workspace['admin'], 'Layer.pdf', 'file', 'Files', sample_pdf(), workspace['team'])


def save(client, doc, raw, revision=1, client_id='tab', **extra):
    return client.post(f'/documents/{doc.pk}/pdf/', {'revision': revision, 'client_id': client_id,
        'file': SimpleUploadedFile('edited.pdf', raw), **extra})


def test_pdf_annotations_save_separately_and_reopen(client, workspace):
    doc = pdf_document(workspace)
    original = active_storage().read(doc.reference)
    edited = original + b'\n% separate annotations'
    client.force_login(workspace['admin'])
    assert save(client, doc, edited).status_code == 200
    assert active_storage().read(doc.reference) == original
    from wiki.pdf_layers import saved_pdf
    assert saved_pdf(doc) == edited
    assert client.get(f'/documents/{doc.pk}/export/').content == edited
    assert client.get(f'/documents/{doc.pk}/export/?original=1').content == original


def test_pdf_layer_external_change_conflicts_and_retains_pending(client, workspace):
    from wiki.models import SaveSession
    doc = pdf_document(workspace)
    original = active_storage().read(doc.reference)
    external = original + b'\n% external'
    active_storage().write('ignored', external, doc.reference)
    client.force_login(workspace['admin'])
    assert save(client, doc, original).status_code == 409
    pending = SaveSession.objects.get(document=doc)
    assert pending.state == 'conflict' and bytes(pending.payload) == original
    assert active_storage().read(doc.reference) == external


def test_pdf_layer_fails_without_damaging_base_and_retries(client, workspace, monkeypatch):
    from wiki.models import SaveSession
    doc = pdf_document(workspace)
    original = active_storage().read(doc.reference)
    adapter = active_storage()
    broken = Mock(wraps=adapter)
    broken.write.side_effect = OSError('secret provider error')
    monkeypatch.setattr('wiki.pdf_layers.active_storage', lambda: broken)
    client.force_login(workspace['admin'])
    assert save(client, doc, original).status_code == 503
    session = SaveSession.objects.get(document=doc)
    assert session.state == 'failed' and bytes(session.payload) == original
    assert 'secret' not in session.error
    assert adapter.read(doc.reference) == original
    monkeypatch.setattr('wiki.pdf_layers.active_storage', lambda: adapter)
    assert save(client, doc, original).status_code == 200


def test_pdf_stale_layer_is_not_applied_to_new_base(client, workspace):
    doc = pdf_document(workspace)
    original = active_storage().read(doc.reference)
    client.force_login(workspace['admin'])
    assert save(client, doc, original + b'\n% annotated').status_code == 200
    external = original + b'\n% new base'
    active_storage().write('ignored', external, doc.reference)
    from wiki.pdf_layers import saved_pdf
    assert saved_pdf(doc) == external
    response = client.get(f'/documents/{doc.pk}/')
    assert response.context['pdf_bootstrap']['layer_state'] == 'conflict'
    assert client.get(f'/documents/{doc.pk}/export/?annotations=1').content == original + b'\n% annotated'
    doc.refresh_from_db()
    assert save(client, doc, external, revision=doc.revision, client_id='new-tab').status_code == 409
    assert save(client, doc, external, revision=doc.revision, client_id='confirmed-tab',
                replace_stale_layer='1').status_code == 200


def test_pdf_layer_checks_revoked_access_before_provider_write(workspace):
    import pytest
    from django.core.exceptions import PermissionDenied
    from wiki.saves import stage
    from wiki.pdf_layers import commit_layer
    doc = pdf_document(workspace)
    doc.inherit_permissions = False
    doc.policy['group']['write'] = True
    doc.save()
    raw = active_storage().read(doc.reference)
    session = stage(doc, workspace['member'], raw, 'pdf:member', doc.revision)
    doc.policy['group']['write'] = False
    doc.save()
    with pytest.raises(PermissionDenied):
        commit_layer(session.pk)
    session.refresh_from_db()
    assert session.state == 'denied' and bytes(session.payload) == raw
    assert active_storage().read(doc.reference) == raw


def test_pdf_layer_rechecks_base_after_provider_write(client, workspace, monkeypatch):
    from wiki.pdf_models import PdfAnnotationLayer
    from wiki.models import SaveSession
    doc = pdf_document(workspace)
    raw = active_storage().read(doc.reference)
    adapter = active_storage()
    racing = Mock(wraps=adapter)
    def write_and_replace_base(key, data):
        reference = adapter.write(key, data)
        adapter.write('ignored', raw + b'\n% changed during layer save', doc.reference)
        return reference
    racing.write.side_effect = write_and_replace_base
    monkeypatch.setattr('wiki.pdf_layers.active_storage', lambda: racing)
    client.force_login(workspace['admin'])
    assert save(client, doc, raw).status_code == 409
    assert not PdfAnnotationLayer.objects.filter(document=doc).exists()
    assert SaveSession.objects.get(document=doc).state == 'conflict'


@pytest.mark.parametrize('missing', [False, True])
def test_pdf_corrupt_annotation_artifact_does_not_hide_original(client, workspace, missing):
    from wiki.pdf_models import PdfAnnotationLayer
    doc = pdf_document(workspace)
    raw = active_storage().read(doc.reference)
    client.force_login(workspace['admin'])
    assert save(client, doc, raw).status_code == 200
    layer = PdfAnnotationLayer.objects.get(document=doc)
    if missing:
        active_storage().delete(layer.reference)
    else:
        active_storage().write('ignored', b'corrupt layer', layer.reference)
    assert client.get(f'/documents/{doc.pk}/export/').status_code == 503
    assert client.get(f'/documents/{doc.pk}/export/?original=1').content == raw
