"""Bounded portable archives. No uploaded paths are extracted to the filesystem."""
import base64
import io
import json
import re
import uuid
import zipfile
from PIL import Image
from pycrdt import Doc, XmlFragment, XmlElement
from django.core.exceptions import ValidationError
from django.db import transaction
from .models import Attachment, Collaboration, Document, Review, PendingDeletion
from .collaboration import current_content, derive
from .services import save_document, validate_content
from .storage import active_storage

MAX_BUNDLE = 50*1024*1024


def export_bundle(document):
    adapter=active_storage()
    room=Collaboration.objects.filter(document=document).first()
    content=current_content(document)
    if room:
        ydoc=Doc();ydoc.apply_update(bytes(room.state));content=derive(ydoc,document.kind)
    manifest={'format':'yourwiki-bundle','version':1,'title':document.title,'kind':document.kind,'content':content,
        'reviews':[{'author':r.author_label or r.author.label,'kind':r.kind,'body':r.body,'anchor':r.anchor,'status':r.status} for r in document.reviews.select_related('author').all()],
        'attachments':[]}
    output=io.BytesIO();total=len(content.encode())
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
        for attachment in document.attachments.all():
            data=adapter.read(attachment.reference);total+=len(data)
            if total>MAX_BUNDLE:raise ValidationError('This bundle exceeds 50 MB. Back up the workspace volumes instead.')
            name=f'images/{attachment.pk}.png';archive.writestr(name,data)
            manifest['attachments'].append({'id':str(attachment.pk),'file':name})
        if room:
            state=bytes(room.state);total+=len(state);archive.writestr('state.bin',state)
        metadata=json.dumps(manifest,ensure_ascii=False).encode();total+=len(metadata)
        if total>MAX_BUNDLE:raise ValidationError('This bundle exceeds 50 MB.')
        archive.writestr('manifest.json',metadata)
    return output.getvalue()


def import_bundle(user,group,upload):
    adapter=active_storage();written=[];document=None
    try:
        with zipfile.ZipFile(upload) as archive:
            infos=archive.infolist()
            if len(infos)>200 or sum(i.file_size for i in infos)>MAX_BUNDLE or len({i.filename for i in infos})!=len(infos):
                raise ValidationError('Invalid or oversized wiki bundle.')
            manifest=json.loads(archive.read('manifest.json'))
            if manifest.get('format')!='yourwiki-bundle' or manifest.get('version')!=1:
                raise ValidationError('Unsupported bundle format.')
            kind,content=manifest['kind'],manifest['content']
            validate_content(kind,content)
            replacements={};assets=[]
            for item in manifest.get('attachments',[]):
                old=str(uuid.UUID(item['id']));new=uuid.uuid4()
                if item['file']!=f'images/{old}.png':raise ValidationError('Invalid attachment path.')
                image=Image.open(io.BytesIO(archive.read(item['file'])))
                if image.format!='PNG' or image.width*image.height>16000000:raise ValidationError('Invalid bundle image.')
                clean=io.BytesIO();image.save(clean,format='PNG');data=clean.getvalue()
                if len(data)>5*1024*1024:raise ValidationError('Bundle image exceeds 5 MB.')
                replacements[f'/attachments/{old}/']=f'/attachments/{new}/'
                assets.append((new,data))
            state=None
            if 'state.bin' in archive.namelist():
                ydoc=Doc();ydoc.apply_update(archive.read('state.bin'))
                if kind=='document':
                    def rewrite(node):
                        if isinstance(node,XmlElement) and node.tag=='image':
                            src=node.attributes.get('src')
                            if src in replacements:node.attributes['src']=replacements[src]
                        if hasattr(node,'children'):
                            for child in node.children:rewrite(child)
                    rewrite(ydoc.get('content',type=XmlFragment))
                content=derive(ydoc,kind);state=ydoc.get_update()
            else:
                for old,new in replacements.items():content=content.replace(old,new)
            validate_content(kind,content)
            reviews=manifest.get('reviews',[])
            if len(reviews)>5000:raise ValidationError('Too many review records.')
            for review in reviews:
                if review.get('kind') not in ('comment','suggestion') or review.get('status') not in ('open','accepted','rejected','resolved') or not isinstance(review.get('body'),str) or len(review['body'])>10000 or len(json.dumps(review.get('anchor',{})))>8000:
                    raise ValidationError('Invalid review record.')
            for id,data in assets:
                reference=adapter.write(f'{id}.png',data);written.append((id,reference))
            document=save_document(user,manifest['title'],kind,'Imported',content,group)
            with transaction.atomic():
                for id,reference in written:Attachment.objects.create(id=id,document=document,reference=reference,content_type='image/png')
                if state:Collaboration.objects.create(document=document,state=state,snapshot=content)
                for r in reviews:Review.objects.create(document=document,author=user,author_label=str(r.get('author','Imported'))[:150],kind=r['kind'],body=r['body'],anchor=r.get('anchor',{}),status=r['status'])
            return document
    except Exception as error:
        if document:
            written.append((None,document.reference));Document.objects.filter(pk=document.pk).delete()
        for _,reference in written:
            try:adapter.delete(reference)
            except Exception:PendingDeletion.objects.create(reference=reference)
        if isinstance(error,ValidationError):raise
        raise ValidationError('The wiki bundle could not be imported. Check its format and storage connection.') from None
