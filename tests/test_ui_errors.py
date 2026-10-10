from unittest.mock import patch
import pytest

pytestmark = pytest.mark.django_db


def test_missing_item_error_is_json_on_ui_route(client, workspace):
    client.force_login(workspace['admin'])
    response = client.get('/documents/00000000-0000-0000-0000-000000000000/export/', HTTP_ACCEPT='application/json')
    assert response.status_code == 404
    assert response.headers['Content-Type'].startswith('application/json')


def test_unexpected_upload_failure_keeps_safe_contract(client, workspace):
    from django.core.files.uploadedfile import SimpleUploadedFile
    client.force_login(workspace['admin'])
    with patch('wiki.views.save_document', side_effect=RuntimeError('private provider details')):
        response = client.post('/files/upload/', {'path':'/', 'file':SimpleUploadedFile('notes.txt', b'notes')}, HTTP_ACCEPT='application/json')
    assert response.status_code == 500
    assert response.json()['error']
    assert b'private provider details' not in response.content


def test_upload_field_errors_are_structured(client, workspace):
    client.force_login(workspace['admin'])
    response = client.post('/files/upload/', {'path':'/'}, HTTP_ACCEPT='application/json')
    assert response.status_code == 400
    assert 'file' in response.json()['errors']


def test_csrf_failure_explains_how_to_recover(workspace):
    from django.test import Client
    response = Client(enforce_csrf_checks=True).post('/login/', {}, HTTP_ACCEPT='application/json')
    assert response.status_code == 500
    assert response['X-Yourwiki-Error'] == 'csrf'
    assert 'Reload the page' in response.json()['error']


def test_unguarded_view_exception_has_safe_response(client, workspace):
    with patch('wiki.views.authenticate', side_effect=RuntimeError('private authentication details')):
        response = client.post('/login/', {'username':'admin','password':'irrelevant'}, HTTP_ACCEPT='application/json')
    assert response.status_code == 500
    assert 'private' not in response.json()['error']
