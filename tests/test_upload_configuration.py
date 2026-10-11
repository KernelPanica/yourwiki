import io
import pytest
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from wiki.models import SiteConfiguration
from wiki.storage import Local, StorageError, bounded
from wiki.services import validate_content
from wiki.administration import SiteForm

pytestmark = pytest.mark.django_db

@pytest.mark.parametrize('value', [0, 8, 1000000])
def test_admin_accepts_arbitrary_upload_limit(value):
    field = SiteForm().fields['document_limit_mb']
    assert field.clean(value) == value
    assert '0' in field.help_text
    with pytest.raises(ValidationError):
        field.clean(-1)

@pytest.mark.parametrize('limit', [8, 0])
def test_large_file_round_trip_and_validation(tmp_path, limit):
    SiteConfiguration.objects.update_or_create(pk=1, defaults={'document_limit_mb':limit})
    data = b'x' * (7 * 1024 * 1024)
    validate_content('file', data)
    storage = Local({'root':str(tmp_path)})
    ref = storage.write('large.bin', data)
    assert storage.read(ref) == data
    assert bounded(data) is data
    SiteConfiguration.objects.filter(pk=1).update(document_limit_mb=1)
    with pytest.raises(StorageError):
        storage.read(ref)
    assert storage.read(ref, limit=None) == data

@pytest.mark.parametrize('limit,size,expected', [(8,7,302),(0,7,302),(1,2,400)])
def test_upload_uses_configured_limit(client, workspace, limit, size, expected):
    SiteConfiguration.objects.update_or_create(pk=1, defaults={'document_limit_mb':limit})
    client.force_login(workspace['admin'])
    response = client.post('/files/upload/', {'path':'/', 'file':SimpleUploadedFile('large.bin', b'x'*(size*1024*1024))})
    assert response.status_code == expected

@pytest.mark.parametrize('limit', [8, 0])
def test_large_office_and_pdf_validation(limit):
    import zipfile
    from pypdf import PdfWriter
    from wiki.models import Document
    from wiki.collabora import validate_file
    from wiki.pdf import process_pdf
    from wiki.file_formats import checked_archive
    SiteConfiguration.objects.update_or_create(pk=1, defaults={'document_limit_mb':limit})
    pdf = PdfWriter()
    pdf.add_blank_page(width=100, height=100)
    pdf.add_attachment('large.bin', b'x' * (6*1024*1024))
    output = io.BytesIO(); pdf.write(output)
    process_pdf(output.getvalue())
    from docx import Document as Word
    output = io.BytesIO(); Word().save(output)
    with zipfile.ZipFile(output, 'a', compression=zipfile.ZIP_STORED) as archive:
        archive.writestr('word/media/large.bin', b'x'*(6*1024*1024))
    data = output.getvalue()
    validate_file(Document(title='large.docx',kind='file'), data)
    with checked_archive(data):
        pass
    SiteConfiguration.objects.filter(pk=1).update(document_limit_mb=1)
    with pytest.raises(ValidationError):
        validate_file(Document(title='large.docx',kind='file'), data)
    with pytest.raises(ValidationError):
        process_pdf(b'%PDF-' + b'x'*(2*1024*1024))


def test_admin_form_saves_unlimited_and_shows_help(client, workspace):
    from django.forms.models import model_to_dict
    config, _ = SiteConfiguration.objects.get_or_create(pk=1)
    data = model_to_dict(config, exclude=SiteForm.Meta.exclude)
    data.update(document_limit_mb=0, image_limit_mb=0)
    form = SiteForm(data, instance=config)
    assert form.is_valid(), form.errors
    form.save()
    config.refresh_from_db()
    assert config.document_limit_mb == config.image_limit_mb == 0
    client.force_login(workspace['admin'])
    response = client.get('/settings/')
    assert response.status_code == 200
    assert '0 — без ограничения' in response.content.decode()
