import base64
import io
import json
import secrets
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.http import HttpResponse, JsonResponse
from django.urls import reverse
from django.shortcuts import get_object_or_404, render, redirect
from django.views.decorators.http import require_http_methods
from django.views.decorators.csrf import ensure_csrf_cookie
from PIL import Image, UnidentifiedImageError
from .collaboration import ensure_room, apply_update
from .models import Attachment, Collaboration, Review
from .services import require
from .storage import active_storage
from .views import document_for, guarded


@guarded
@ensure_csrf_cookie
def live(request, id):
    doc = document_for(request.user, id)
    from .collabora import eligible
    if eligible(doc):
        return redirect('office', id=doc.pk)
    if doc.kind in ('file', 'presentation'): return redirect('document', id=doc.pk)
    room = ensure_room(doc)
    doc = document_for(request.user,id)
    return render(request, 'wiki/live.html', {'doc':doc, 'section':doc.title,
        'can_export':doc.can_export(request.user),'bootstrap':{'id':str(doc.pk),'kind':doc.kind,'title':doc.title,'export':doc.can_export(request.user),'write':doc.allows(request.user,'write'),
            'generation':str(room.generation), 'file_format':doc.file_format,'user':request.user.label,'state':base64.b64encode(bytes(room.state)).decode(), 'sequence':room.sequence}})


@guarded
@require_http_methods(['GET'])
def status(request, id):
    document_for(request.user, id)
    return collaboration_status(id)


def collaboration_status(id):
    room = get_object_or_404(Collaboration, document_id=id)
    from .saves import status as save_status
    return JsonResponse({'generation':str(room.generation), 'sequence':room.sequence, 'synced_sequence':room.synced_sequence, **save_status(id)})


@guarded
@require_http_methods(['GET'])
def storage_status(request, id):
    document_for(request.user, id)
    from .external_sync import refresh, INTERVAL
    refresh(id)
    doc = document_for(request.user, id)
    result = {'fingerprint':doc.storage_digest, 'revision':doc.revision, 'interval':INTERVAL}
    if doc.kind == 'file' and doc.title.lower().endswith('.pdf'):
        from .pdf_layers import layer_state
        result['layer_state'] = layer_state(doc)
    return JsonResponse(result)


@guarded
@require_http_methods(['POST'])
def metadata(request,id):
    data=json.loads(request.body)
    title=data.get('title','').strip()
    if not title or len(title)>200:
        raise ValidationError('Enter a title of at most 200 characters.')
    from .folders import move_item
    with transaction.atomic():
        doc=document_for(request.user,id,'write')
        move_item(request.user, doc, doc.folder, rename=title)
    return JsonResponse({'title':title})


@guarded
@require_http_methods(['GET', 'POST'])
def reviews(request, id):
    doc = document_for(request.user, id)
    if doc.kind != 'document':
        raise ValidationError('Reviews are available on text documents.')
    if request.method == 'POST':
        data = json.loads(request.body)
        if not isinstance(data, dict): raise ValidationError('Use a JSON object.')
        kind, body, anchor = data.get('kind','comment'), data.get('body',''), data.get('anchor',{})
        if kind not in ('comment','suggestion') or not isinstance(body,str) or len(body)>10000 or (not body.strip() and kind == 'comment'):
            raise ValidationError('Enter a comment or suggested replacement of at most 10,000 characters.')
        if not isinstance(anchor,dict) or len(json.dumps(anchor)) > 8000:
            raise ValidationError('Invalid review anchor.')
        Review.objects.create(document=doc, author=request.user, kind=kind, body=body, anchor=anchor)
    return JsonResponse([{'id':r.pk,'author':r.author_label or r.author.label,'kind':r.kind,'body':r.body,'anchor':r.anchor,'status':r.status} for r in doc.reviews.select_related('author').order_by('created_at')],safe=False)


@guarded
@require_http_methods(['POST'])
def resolve_review(request, id, review_id):
    doc = document_for(request.user, id, 'write')
    data = json.loads(request.body)
    action = data.get('action')
    review = get_object_or_404(Review, pk=review_id, document=doc, status='open')
    if action == 'accept' and review.kind == 'suggestion':
        if not data.get('update'):
            raise ValidationError('An accepted suggestion must include its collaborative update.')
        sequence = apply_update(request.user, id, data['update'], review.pk)
        return JsonResponse({'sequence':sequence})
    if action not in ('reject','resolve'):
        raise ValidationError('Invalid review action.')
    review.status, review.resolved_by = ('rejected' if action == 'reject' else 'resolved'), request.user
    review.save(update_fields=['status','resolved_by'])
    return JsonResponse({'status':review.status})


@guarded
@require_http_methods(['POST'])
def upload_attachment(request, id):
    doc = document_for(request.user, id, 'write')
    require(doc, request.user, 'read')
    upload = request.FILES.get('file')
    from .models import SiteConfiguration
    config=SiteConfiguration.current()
    from .storage import image_limit_bytes
    cap = image_limit_bytes()
    if not upload or (cap is not None and upload.size > cap):
        raise ValidationError('Choose a PNG, JPEG or WebP image within the configured size limit.')
    try:
        im = Image.open(upload)
        if im.format not in ('PNG','JPEG','WEBP') or im.width*im.height > config.image_limit_megapixels*1000000:
            raise ValueError()
        im.load()
        clean = io.BytesIO()
        im.save(clean, format='PNG')
        value = clean.getvalue()
        if cap is not None and len(value) > cap: raise ValueError()
    except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError):
        raise ValidationError('The image is invalid or exceeds the configured size or megapixel limit.')
    adapter = active_storage()
    from .folders import storage_path
    directory = storage_path(doc.folder)
    reference = adapter.write(f'{directory + "/" if directory else ""}.attachments/{doc.pk}-{secrets.token_hex(16)}.png', value, limit=cap)
    try:
        with transaction.atomic():
            document_for(request.user, id, 'write')
            attachment = Attachment.objects.create(document=doc, reference=reference, content_type='image/png')
    except Exception:
        adapter.delete(reference)
        raise
    return JsonResponse({'url':f'/attachments/{attachment.pk}/'},status=201)


@guarded
def attachment(request, id):
    item = get_object_or_404(Attachment.objects.select_related('document'), pk=id)
    require(item.document, request.user, 'read')
    from .storage import image_limit_bytes
    return HttpResponse(active_storage().read(item.reference, limit=image_limit_bytes()), content_type=item.content_type)


@guarded
@require_http_methods(['POST'])
def flush(request, id):
    doc=document_for(request.user,id,'write')
    data=json.loads(request.body or '{}')
    if not isinstance(data,dict):raise ValidationError('Use a JSON object.')
    if data.get('update'):
        if not data.get('generation'):
            from .services import Conflict
            raise Conflict('Reload the editor before sending changes.')
        apply_update(request.user,id,data['update'],generation=data.get('generation'))
    from .collaboration import flush_room
    flush_room(id)
    return collaboration_status(id)


@guarded
@require_http_methods(['POST'])
def recover(request, id):
    """Explicit recovery; never overwrite an externally changed original."""
    from .models import Document, SaveSession
    from .services import Conflict, save_document, validate_content
    doc=document_for(request.user,id,'write')
    data=json.loads(request.body)
    if not isinstance(data,dict):raise ValidationError('Use a JSON object.')
    if data.get('action')=='reload':
        if data.get('discard') is not True:raise ValidationError('Confirm discarding your pending changes.')
        from .realtime import connections
        if connections.get(str(id)):raise Conflict('Close active editors before reloading the original.')
        from .file_formats import decode
        with transaction.atomic():
            doc=document_for(request.user,id,'write')
            raw=active_storage().read(doc.reference)
            if doc.kind!='file':decode(doc,raw)
            doc.storage_digest=active_storage().fingerprint(doc.reference,raw);doc.revision+=1
            doc.save(update_fields=['storage_digest','revision'])
            from .write_journal import discard
            discard(doc)
            Collaboration.objects.filter(document=doc).delete()
            SaveSession.objects.filter(document=doc).delete()
        return JsonResponse({'revision':doc.revision})
    if data.get('action')!='copy' or doc.kind=='file':raise ValidationError('Choose a recovery action.')
    if not doc.can_export(request.user):
        from .acl import ResourcePermissionDenied
        raise ResourcePermissionDenied
    try:
        from pycrdt import Doc
        from .collaboration import derive
        update=base64.b64decode(data.get('update',''),validate=True)
        if not update or len(update)>6*1024*1024:raise ValueError()
        state=Doc();state.apply_update(update);content=derive(state,doc.kind)
    except Exception:
        raise ValidationError('Invalid editor snapshot.') from None
    title=data.get('title','').strip()
    if not title:raise ValidationError('Enter a name for the copy.')
    saved=save_document(request.user,title,doc.kind,doc.collection,content,doc.group,folder=doc.folder,file_format=doc.file_format or None)
    return JsonResponse({'url':reverse('live',args=[saved.pk])},status=201)
