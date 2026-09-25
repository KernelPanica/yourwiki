import io
import json
import zipfile
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.exceptions import ValidationError
from wiki.models import Review, Attachment, Collaboration
from wiki.collaboration import ensure_room, current_content
from wiki.bundles import export_bundle, import_bundle
from wiki.source import acquire,release
from wiki.services import Conflict, save_document

pytestmark=pytest.mark.django_db


def test_bundle_preserves_content_reviews_and_state(workspace,document):
    ensure_room(document)
    Review.objects.create(document=document,author=workspace['member'],body='Keep this comment',kind='comment')
    archive=export_bundle(document)
    copy=import_bundle(workspace['admin'],workspace['team'],io.BytesIO(archive))
    assert copy.pk!=document.pk
    assert 'Some knowledge' in current_content(copy)
    assert copy.reviews.get().body=='Keep this comment'
    assert copy.reviews.get().author_label=='Member'
    assert Collaboration.objects.get(document=copy).state


def test_bundle_rewrites_image_references(client,workspace,document):
    from PIL import Image
    from wiki.storage import active_storage
    from wiki.native import pack
    from wiki.models import Attachment
    raw=io.BytesIO();Image.new('RGB',(2,2)).save(raw,'PNG')
    item=Attachment.objects.create(document=document,reference=active_storage().write('bundle-image.png',raw.getvalue()),content_type='image/png')
    content=pack('document',{'type':'doc','content':[{'type':'image','attrs':{'src':f'/attachments/{item.pk}/','alt':'Tiny image'}}]})
    document=save_document(workspace['admin'],document.title,document.kind,document.collection,content,document.group,document,document.revision)
    ensure_room(document)
    copy=import_bundle(workspace['admin'],workspace['team'],io.BytesIO(export_bundle(document)))
    new=copy.attachments.get()
    assert str(new.pk) in current_content(copy) and str(item.pk) not in current_content(copy)
    client.force_login(workspace['admin'])
    assert client.get(f'/attachments/{new.pk}/').status_code==200


def test_bundle_cannot_extract_arbitrary_paths(workspace):
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w') as archive:
        archive.writestr('manifest.json',json.dumps({'format':'yourwiki-bundle','version':1,'kind':'document','title':'Bad','content':'hello','attachments':[{'id':'00000000-0000-0000-0000-000000000000','file':'../../secret'}]}))
    stream.seek(0)
    with pytest.raises(ValidationError):import_bundle(workspace['admin'],workspace['team'],stream)


def test_exclusive_source_replaces_room_without_lost_live_edits(workspace,document):
    ensure_room(document)
    token=acquire(document,workspace['admin'])
    with pytest.raises(Conflict):ensure_room(document)
    with pytest.raises(Conflict):save_document(workspace['admin'],document.title,document.kind,document.collection,'wrong',document.group,document,document.revision)
    changed=save_document(workspace['admin'],document.title,document.kind,document.collection,'# Source update',document.group,document,document.revision,source_token=token)
    assert not Collaboration.objects.filter(document=changed).exists()
    room=ensure_room(changed)
    assert 'Source update' in room.snapshot


def test_source_cancel_releases_lock(client,workspace,document):
    client.force_login(workspace['admin'])
    url=f'/documents/{document.pk}/edit/?source=1'
    assert client.get(url).status_code==200
    assert client.get(f'/documents/{document.pk}/live/').status_code==409
    assert client.post(url,{'cancel_source':'1'}).status_code==302
    assert client.get(f'/documents/{document.pk}/live/').status_code==200
