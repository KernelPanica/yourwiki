from io import BytesIO

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image

from wiki.models import Document


@pytest.mark.parametrize('image_format,mime', [('PNG', 'image/png'), ('JPEG', 'image/jpeg'), ('GIF', 'image/gif'), ('WEBP', 'image/webp'), ('BMP', 'image/bmp')])
def test_image_preview_and_download(client, workspace, image_format, mime):
    stream = BytesIO()
    Image.new('RGB', (20, 10), 'blue').save(stream, format=image_format)
    content = stream.getvalue()
    client.force_login(workspace['admin'])
    response = client.post('/files/upload/', {'file': SimpleUploadedFile('picture.' + image_format.lower(), content), 'path': '/'})
    assert response.status_code == 302
    doc = Document.objects.get()
    url = f'/documents/{doc.pk}/'
    html = client.get(url).content.decode()
    assert f'<img src="{url}export/?inline=1"' in html
    response = client.get(url + 'export/?inline=1')
    assert response['Content-Type'] == mime
    assert response['Content-Disposition'].startswith('inline;')
    assert response['X-Content-Type-Options'] == 'nosniff'
    assert response.content == content
    assert client.get(url + 'export/')['Content-Disposition'].startswith('attachment;')
    client.force_login(workspace['outsider'])
    assert client.get(url + 'export/?inline=1').status_code == 500


@pytest.mark.parametrize('content', [b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', b'<html>not an image</html>', b'\x89PNG\r\n\x1a\ntruncated'])
def test_unverified_files_are_download_only(client, workspace, content):
    client.force_login(workspace['admin'])
    client.post('/files/upload/', {'file': SimpleUploadedFile('fake.png', content), 'path': '/'})
    doc = Document.objects.get()
    url = f'/documents/{doc.pk}/'
    assert '<img src=' not in client.get(url).content.decode()
    response = client.get(url + 'export/?inline=1')
    assert response['Content-Type'] == 'application/octet-stream'
    assert response['Content-Disposition'].startswith('attachment;')


def test_delete_buttons_and_server_permissions(client, workspace, document):
    from django.test import Client
    from wiki.storage import active_storage, StorageError

    document.policy['group'].update(visible=True, read=True, write=False)
    document.save()
    client.force_login(workspace['member'])
    url = f'/documents/{document.pk}/'
    delete_url = url + 'delete/'
    for page in ('/', '/?view=grid', '/folders/', url):
        assert f'href="{delete_url}"' not in client.get(page).content.decode()
    assert client.post(delete_url).status_code == 500
    assert Document.objects.filter(pk=document.pk).exists()
    document.policy['group']['write'] = True
    document.save()
    for page in ('/', '/?view=grid', '/folders/', url):
        assert f'href="{delete_url}"' in client.get(page).content.decode()
    assert client.get(delete_url).status_code == 200
    assert Document.objects.filter(pk=document.pk).exists()  # GET only confirms.
    csrf_client = Client(enforce_csrf_checks=True)
    csrf_client.force_login(workspace['member'])
    assert csrf_client.post(delete_url).status_code in (403, 500)
    assert Document.objects.filter(pk=document.pk).exists()
    assert client.post(delete_url).status_code == 302
    assert not Document.objects.filter(pk=document.pk).exists()
    with pytest.raises(StorageError):
        active_storage().read(document.reference)
