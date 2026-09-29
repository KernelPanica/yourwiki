import json
from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen.canvas import Canvas

from wiki.crypto import decrypt, encrypt
from wiki.models import Document, SiteConfiguration
from wiki.pdf import process_pdf
from wiki.services import save_document
from wiki.storage import active_storage

pytestmark = pytest.mark.django_db


def sample_pdf():
    stream = BytesIO()
    canvas = Canvas(stream, pagesize=(600, 800))
    canvas.drawString(40, 740, 'Quarterly report: revenue increased 12 percent.')
    canvas.acroForm.textfield(name='customer', x=40, y=640, width=220, height=30, value='Original customer')
    canvas.showPage()
    canvas.save()
    return stream.getvalue()


@pytest.mark.parametrize('url', ['/files/upload/', '/documents/import/'])
def test_pdf_upload_view_fill_and_conflict(client, workspace, url):
    source = sample_pdf()
    client.force_login(workspace['admin'])
    response = client.post(url, {'path': '/', 'file': SimpleUploadedFile('report.pdf', source)})
    assert response.status_code == 302
    doc = Document.objects.get(title='report.pdf')
    assert doc.kind == 'file'
    assert active_storage().read(doc.reference) == source
    page = client.get(f'/documents/{doc.pk}/')
    assert b'pdf-container' in page.content and b'Save PDF' in page.content
    response = client.get(f'/documents/{doc.pk}/export/?inline=1')
    assert response['Content-Type'] == 'application/pdf'
    assert response['Content-Disposition'].startswith('inline')
    assert response.content == source
    writer = PdfWriter(clone_from=BytesIO(source))
    writer.update_page_form_field_values(writer.pages[0], {'customer': 'Updated customer'})
    stream = BytesIO(); writer.write(stream)
    save_url = f'/documents/{doc.pk}/pdf/'
    response = client.post(save_url, {'revision': 1, 'file': SimpleUploadedFile('report.pdf', stream.getvalue())})
    assert response.status_code == 200
    doc.refresh_from_db()
    assert doc.revision == 2
    edited = active_storage().read(doc.reference)
    reader = PdfReader(BytesIO(edited))
    assert reader.get_fields()['customer']['/V'] == 'Updated customer'
    assert reader.pages[0].extract_text() == PdfReader(BytesIO(source)).pages[0].extract_text()
    assert client.post(save_url, {'revision': 1, 'file': SimpleUploadedFile('report.pdf', source)}).status_code == 409
    doc.refresh_from_db()
    assert active_storage().read(doc.reference) == edited
    assert 'Updated customer' in process_pdf(edited, extract=True)['text']
    assert client.post(save_url, {'revision': 2, 'file': SimpleUploadedFile('report.pdf', b'not a PDF')}).status_code == 400
    csrf_client = Client(enforce_csrf_checks=True); csrf_client.force_login(workspace['admin'])
    assert csrf_client.post(save_url, {}).status_code == 500
    client.force_login(workspace['member'])
    assert b'pdf-save"' not in client.get(f'/documents/{doc.pk}/').content
    assert client.post(save_url, {}).status_code == 500
    client.force_login(workspace['outsider'])
    assert client.get(f'/documents/{doc.pk}/export/?inline=1').status_code == 500
    assert client.get(f'/documents/{doc.pk}/summary/').status_code == 500


def test_pdf_validation_and_scans(client, workspace):
    from django.core.exceptions import ValidationError
    writer = PdfWriter(); writer.add_blank_page(600, 800)
    stream = BytesIO(); writer.write(stream)
    assert process_pdf(stream.getvalue())['pages'] == 1
    with pytest.raises(ValidationError, match='OCR'):
        process_pdf(stream.getvalue(), extract=True)
    writer.encrypt('secret'); stream = BytesIO(); writer.write(stream)
    with pytest.raises(ValidationError, match='Unlock'):
        process_pdf(stream.getvalue())
    client.force_login(workspace['admin'])
    assert client.post('/files/upload/', {'path': '/', 'file': SimpleUploadedFile('bad.pdf', b'%PDF-bad')}).status_code == 400
    assert not Document.objects.exists()


def api_response(value, status=200):
    response = MagicMock()
    response.status_code = status
    response.iter_content.return_value = [json.dumps(value).encode()]
    response.__enter__.return_value = response
    return response


@pytest.mark.parametrize('provider', ['openai', 'deepseek', 'qwen', 'gemini', 'claude', 'compatible'])
def test_summary_provider_payloads(provider):
    from wiki.ai import summarize, PROVIDERS
    value = {'content': [{'type': 'text', 'text': 'Краткое резюме'}]} if provider == 'claude' else {'choices': [{'message': {'content': 'Краткое резюме'}, 'finish_reason': 'stop'}]}
    config = {'model': 'chosen-model', 'api_key': 'private-key', 'base_url': 'https://example.test/v1' if provider == 'compatible' else ''}
    with patch('wiki.ai.requests.post', return_value=api_response(value)) as post:
        assert summarize(provider, config, 'Document facts', 'ru') == ('Краткое резюме', False)
    url = post.call_args.args[0]
    options = post.call_args.kwargs
    assert url.startswith(config['base_url'] or PROVIDERS[provider][1])
    assert options['allow_redirects'] is False
    assert options['json']['model'] == 'chosen-model'
    assert options['json']['messages'][-1]['content'] == 'Document facts'
    assert 'Russian' in (options['json']['system'] if provider == 'claude' else options['json']['messages'][0]['content'])
    if provider == 'claude':
        assert url.endswith('/messages') and options['headers']['x-api-key'] == 'private-key'
    else:
        assert url.endswith('/chat/completions') and options['headers']['Authorization'] == 'Bearer private-key'


def test_ai_settings_encryption_and_pdf_summary(client, workspace):
    client.force_login(workspace['member'])
    assert client.get('/settings/ai/').status_code == 500
    client.force_login(workspace['admin'])
    data = {'provider': 'openai', 'model': 'chosen-model', 'api_key': 'secret-provider-key', 'enabled': 'on'}
    assert client.post('/settings/ai/', data).status_code == 302
    config = SiteConfiguration.current()
    assert 'secret-provider-key' not in config.encrypted_ai_config
    assert decrypt(config.encrypted_ai_config)['openai']['api_key'] == 'secret-provider-key'
    assert b'secret-provider-key' not in client.get('/settings/ai/').content
    data['api_key'] = ''
    assert client.post('/settings/ai/', data).status_code == 302
    data['base_url'] = 'https://another.example/v1'
    assert client.post('/settings/ai/', data).status_code == 400
    doc = save_document(workspace['admin'], 'report.pdf', 'file', 'Reports', sample_pdf(), workspace['team'])
    client.force_login(workspace['member'])
    value = {'choices': [{'message': {'content': '<script>alert(1)</script> Summary'}, 'finish_reason': 'stop'}]}
    with patch('wiki.ai.requests.post', return_value=api_response(value)) as post:
        response = client.post(f'/documents/{doc.pk}/summary/', {'provider': 'openai'})
    assert response.status_code == 200
    assert b'&lt;script&gt;' in response.content
    sent = post.call_args.kwargs['json']['messages'][-1]['content']
    assert 'Quarterly report' in sent and 'Original customer' in sent
    assert '%PDF-' not in sent and 'base64' not in sent
    with patch('wiki.ai.requests.post', return_value=api_response({'error': 'secret-provider-key'}, 401)):
        response = client.post(f'/documents/{doc.pk}/summary/', {'provider': 'openai'})
    assert response.status_code == 400 and b'secret-provider-key' not in response.content
    client.force_login(workspace['outsider'])
    with patch('wiki.ai.requests.post') as post:
        assert client.post(f'/documents/{doc.pk}/summary/', {'provider': 'openai'}).status_code == 500
        post.assert_not_called()
