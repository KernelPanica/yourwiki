"""Read and restore provider-side snapshots without re-encoding original bytes."""
import base64
import hashlib
import json
from django.contrib import messages
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import F
from django.http import HttpResponse, JsonResponse
from django.shortcuts import redirect, render
from django.urls import reverse
from django.utils import timezone
from django.utils.http import content_disposition_header
from django.views.decorators.http import require_GET, require_POST
from .views import guarded, document_for
from .storage import active_storage
from .services import Conflict, storage_key


def entries(document):
    if not document.history_reference:
        return []
    try:
        value = json.loads(active_storage().read(document.history_reference, limit=None))
        if value.get('format') != 'yourwiki-history' or value.get('version') != 1 or not isinstance(value.get('entries'), list):
            raise ValueError()
        if any(not isinstance(entry, dict) for entry in value['entries']):
            raise ValueError()
        return value['entries']
    except (ValueError, TypeError, AttributeError):
        raise ValidationError('История версий повреждена. Исходный файл не изменён.') from None


def snapshot(document, index):
    versions = entries(document)
    if index < 0 or index >= len(versions):
        raise ValidationError('Версия не найдена.')
    entry = versions[index]
    try:
        data = base64.b64decode(entry['content_base64'], validate=True)
        if hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise ValidationError('Проверка целостности версии не пройдена. Исходный файл не изменён.') from None
    return entry, data


def version_name(document, entry):
    name = entry.get('title') or document.title
    extension = entry.get('file_format', document.file_format)
    if not extension and document.kind!='file':
        from .services import EXTENSIONS
        extension='wiki.json' if document.format_version and document.kind in ('document','table') else EXTENSIONS.get(document.kind,'')
    return name + '.' + extension if extension and not name.lower().endswith('.'+extension) else name


@guarded
@require_GET
def versions(request, id):
    doc = document_for(request.user, id)
    rows = []
    for index, entry in reversed(list(enumerate(entries(doc)))):
        author = entry.get('author')
        rows.append({'index': index, 'revision': entry.get('revision'), 'saved_at': entry.get('saved_at'),
                     'author': author.get('name', '') if isinstance(author, dict) else '',
                     'view_url': reverse('version-preview', args=[id, index]),
                     'download_url': reverse('version-download', args=[id, index]),
                     'restore_url': reverse('version-restore', args=[id, index]), 'sha256': entry.get('sha256', '')})
    return JsonResponse({'versions': rows, 'revision': doc.revision, 'can_write': doc.allows(request.user, 'write'),
                         'enabled': doc.history_enabled()})


@guarded
@require_GET
def download(request, id, index):
    doc = document_for(request.user, id)
    entry, data = snapshot(doc, index)
    name = version_name(doc, entry)
    from .office_formats import mime
    content_type = mime(name.rsplit('.', 1)[-1])
    inline = request.GET.get('inline') == '1' and name.lower().endswith('.pdf') and data.startswith(b'%PDF-')
    response = HttpResponse(data, content_type='application/pdf' if inline else content_type)
    response['Content-Disposition'] = content_disposition_header(not inline, name)
    if inline:
        response['X-Frame-Options']='SAMEORIGIN'
    response['X-Content-Type-Options'] = 'nosniff'
    response['Cache-Control'] = 'private, no-store'
    return response


@guarded
@require_GET
def preview(request, id, index):
    doc = document_for(request.user, id)
    entry, data = snapshot(doc, index)
    context = {'doc': doc, 'entry': entry, 'index': index, 'current_revision': doc.revision,
               'can_write': doc.allows(request.user, 'write'), 'history_enabled': doc.history_enabled()}
    try:
        name = version_name(doc, entry)
        if name.lower().endswith('.pdf') and data.startswith(b'%PDF-'):
            context['pdf_url'] = reverse('version-download', args=[id, index])+'?inline=1'
        elif name.lower().endswith(('.docx','.ods','.md')) or doc.kind not in ('file', 'presentation'):
            from .file_formats import decode
            from .previews import preview as render_preview
            target=doc
            kind=doc.kind
            if doc.kind=='file':
                from types import SimpleNamespace
                extension=name.rsplit('.',1)[-1].lower()
                kind='table' if extension=='ods' else 'document'
                target=SimpleNamespace(file_format=extension)
            content = decode(target, data)
            context.update({'drawio_source': content} if kind == 'drawio' else render_preview(kind, content))
        else:
            context['download_only'] = True
    except Exception:
        context['download_only'] = True
    return render(request, 'wiki/version_preview.html', context)


@guarded
@require_POST
@transaction.atomic
def restore(request, id, index):
    doc = document_for(request.user, id, 'write')
    if request.POST.get('revision') != str(doc.revision):
        raise Conflict('Файл изменился. Обновите историю версий перед восстановлением.')
    entry, data = snapshot(doc, index)
    if request.POST.get('sha256') != entry['sha256']:
        raise Conflict('История изменилась. Откройте выбранную версию заново.')
    if entry.get('file_format', doc.file_format) != doc.file_format or entry.get('kind', doc.kind) != doc.kind:
        raise ValidationError('Формат этой версии отличается от текущего файла. Скачайте её как отдельный файл.')
    if doc.file_format in ('docx', 'ods', 'pptx'):
        from .collabora import validate_file
        validate_file(doc, data)
    from .source import check_available
    from .realtime import connections
    from .models import Collaboration, SaveSession
    check_available(doc)
    if connections.get(str(doc.pk)) or Collaboration.objects.filter(document=doc, sequence__gt=F('synced_sequence')).exists() or SaveSession.objects.filter(document=doc, state__in=['pending', 'unknown']).exists():
        raise Conflict('Закройте редакторы и сохраните текущие изменения перед восстановлением версии.')
    from .saves import write_snapshot
    doc.reference = write_snapshot(doc, data, storage_key(doc), user=request.user, raw=True)
    doc.revision += 1
    doc.updated_at = timezone.now()
    doc.save(update_fields=['reference', 'storage_digest', 'history_reference', 'revision', 'updated_at'])
    from .write_journal import acknowledge
    acknowledge(doc)
    Collaboration.objects.filter(document=doc).delete()
    messages.success(request, 'Версия восстановлена в Yourwiki и исходном хранилище.')
    return redirect('document', id=doc.pk)
