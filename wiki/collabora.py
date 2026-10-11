"""Collabora WOPI host: signed capabilities, shared leases and exact-byte saves."""
from datetime import timedelta
from functools import wraps
from pathlib import PurePosixPath
from urllib.parse import urlencode, urlsplit, urlunsplit
import secrets
import io
import zipfile

import requests
from defusedxml.ElementTree import fromstring
from django.conf import settings
from django.core import signing
from django.core.cache import cache
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction, models
from django.http import Http404, HttpResponse, JsonResponse
from django.shortcuts import render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from .models import Document, OfficeSession, User, Collaboration, SaveSession
from .services import Conflict, require, storage_key
from .storage import active_storage, StorageError, file_limit_bytes
from .views import guarded, document_for

TOKEN_AGE = 8 * 60 * 60
LEASE = timedelta(minutes=30)
SALT = 'yourwiki.collabora.wopi.v1'
from .office_formats import SUPPORTED, extension, mime, TEXT, OLE, OPENXML, ODF, FLAT


def eligible(document):
    if not settings.COLLABORA_URL or document.kind not in ('document', 'table', 'presentation', 'file'):
        return False
    ext = extension(document)
    if ext not in SUPPORTED:
        return False
    return True


def check_available(document):
    if OfficeSession.objects.filter(document=document).filter(
            expires_at__gt=timezone.now()).exists() or OfficeSession.objects.filter(
            document=document).exclude(pending=b'').exists():
        raise Conflict('A Collabora session is active or has unsaved changes. Open Collabora or download its recovery copy before using another editor.')


def origin(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password:
        raise ValidationError('Configure a valid Collabora HTTP(S) URL.')
    return f'{parsed.scheme}://{parsed.netloc}'


def validate_file(document, data):
    from .file_formats import checked_archive
    ext = extension(document)
    cap = file_limit_bytes()
    if (cap is not None and len(data) > cap) or (not data and ext not in TEXT):
        raise ValidationError('Office files must fit the configured size limit and match their format.')
    try:
        if ext in TEXT:
            data.decode('utf-8-sig')
            if b'\x00' in data:
                raise ValueError()
        elif ext == 'rtf':
            if not data.lstrip().startswith(b'{\\rtf'):
                raise ValueError()
        elif ext in OLE:
            if not data.startswith(bytes.fromhex('d0cf11e0a1b11ae1')):
                raise ValueError()
        elif ext == 'dbf':
            if len(data) < 32 or data[0] not in (3, 4, 5, 0x30, 0x31, 0x32, 0x43, 0x63, 0x83, 0x8b, 0xcb, 0xf5):
                raise ValueError()
        elif ext in FLAT:
            root = fromstring(data)
            if root.tag != '{urn:oasis:names:tc:opendocument:xmlns:office:1.0}document':
                raise ValueError()
        else:
            with checked_archive(data) as archive:
                if ext in OPENXML:
                    part = archive.read(OPENXML[ext])
                    archive.getinfo('[Content_Types].xml')
                    if ext != 'xlsb':
                        fromstring(part)
                elif ext in ODF and archive.read('mimetype').decode() == mime(ext):
                    fromstring(archive.read('content.xml'))
                else:
                    raise ValueError()
    except Exception as error:
        raise ValidationError('The office file is damaged or does not match its format.') from error


def editor_action(extension, writable):
    """Fetch discovery internally, but submit only to the configured public origin."""
    public = settings.COLLABORA_URL
    origin(public)
    key = 'collabora-discovery:' + settings.COLLABORA_INTERNAL_URL
    xml = cache.get(key)
    if xml is None:
        response = requests.get(settings.COLLABORA_INTERNAL_URL + '/hosting/discovery', timeout=10,
                                allow_redirects=False)
        response.raise_for_status()
        if len(response.content) > 2 * 1024 * 1024:
            raise ValidationError('Invalid Collabora discovery response.')
        xml = response.content
        cache.set(key, xml, 300)
    actions = fromstring(xml).findall('.//action')
    names = ('edit',) if writable else ('view', 'edit')
    action = next((a for name in names for a in actions if a.get('ext') == extension and a.get('name') == name), None)
    if action is None:
        raise ValidationError('Collabora does not support this file format.')
    path = urlsplit(action.get('urlsrc', '')).path
    prefix = urlsplit(public).path.rstrip('/')
    if not path.startswith(prefix + '/browser/') or not path.endswith('/cool.html'):
        raise ValidationError('Collabora service_root must match COLLABORA_URL.')
    parsed = urlsplit(public)
    return urlunsplit((parsed.scheme, parsed.netloc, path, '', ''))


def open_session(document, user):
    from .realtime import connections
    with transaction.atomic():
        document = Document.objects.get(pk=document.pk)
        require(document, user, 'read')
        existing = OfficeSession.objects.filter(document=document, superseded=False).first()
        if existing and (existing.expires_at > timezone.now() or existing.pending):
            if existing.pending and existing.expires_at <= timezone.now():
                existing.expires_at = timezone.now() + LEASE
                existing.save(update_fields=['expires_at'])
            return existing
        from .models import SourceLease
        if SourceLease.objects.filter(document=document, expires_at__gt=timezone.now()).exists():
            raise Conflict('Close the source editor before opening Collabora.')
        room = Collaboration.objects.filter(document=document).first()
        if connections.get(str(document.pk)) or (room and room.sequence != room.synced_sequence) or SaveSession.objects.filter(document=document).exclude(state='saved').exists():
            raise Conflict('Save and close the existing Yourwiki editors before opening Collabora.')
        data = active_storage().read(document.reference)
        validate_file(document, data)
        fingerprint = active_storage().fingerprint(document.reference, data)
        if document.storage_digest != fingerprint:
            document.storage_digest = fingerprint
            document.revision += 1
            document.save(update_fields=['storage_digest', 'revision'])
        if existing:
            existing.delete()
        return OfficeSession.objects.create(document=document, base_digest=fingerprint,
                                            expires_at=timezone.now() + LEASE)


def token_for(session, user):
    return signing.dumps({'session': str(session.pk), 'user': user.pk,
                          'write': session.document.allows(user, 'write'), 'nonce': secrets.token_hex(8)}, salt=SALT)


@guarded
@require_http_methods(['GET'])
def editor(request, id):
    doc = document_for(request.user, id)
    if not eligible(doc):
        raise ValidationError('Collabora is disabled or this file uses another editor.')
    # Discovery must succeed before reserving the file.
    action = editor_action(extension(doc), doc.allows(request.user, 'write'))
    session = open_session(doc, request.user)
    google_sheet = False
    if extension(doc) == 'ods':
        mount, _ = active_storage().reference(doc.reference)
        google_sheet = mount.provider == 'google'
    wopi_url = settings.COLLABORA_WOPI_URL + reverse('wopi-info', args=[session.pk])
    action += '?' + urlencode({'WOPISrc': wopi_url, 'lang': request.LANGUAGE_CODE})
    return render(request, 'wiki/office.html', {'doc': doc, 'section': doc.title,
        'office_action': action, 'office_token': token_for(session, request.user),
        'office_google_sheet': google_sheet,
        'office_presentation': extension(doc) in {'ppt', 'pptx', 'pptm', 'potx', 'potm', 'ppsx', 'odp', 'otp', 'fodp'},
        'office_recovery': bool(session.pending) and (session.pending_author_id == request.user.pk or request.user.is_superuser),
        'office_ttl': int((timezone.now() + timedelta(seconds=TOKEN_AGE)).timestamp() * 1000),
        'office_bootstrap': {'origin': origin(settings.COLLABORA_URL), 'session': str(session.pk),
                            'write': doc.allows(request.user, 'write'), 'interval': 30,
                            'export_format': 'pptx' if extension(doc) in {'ppt', 'pptx', 'pptm', 'potx', 'potm', 'ppsx', 'odp', 'otp', 'fodp'} else 'xlsx' if extension(doc) in {'ods', 'ots', 'fods', 'xls', 'xlsx', 'xlsm', 'xlsb', 'xltx', 'xltm', 'xla', 'csv', 'tsv', 'dif', 'slk', 'dbf'} else 'docx',
                            'status': reverse('office-status', args=[doc.pk])}})


def wopi(view):
    @csrf_exempt
    @wraps(view)
    def wrapped(request, id):
        try:
            if not settings.COLLABORA_URL:
                raise PermissionDenied
            claims = signing.loads(request.GET.get('access_token', ''), salt=SALT, max_age=TOKEN_AGE)
            if claims.get('session') != str(id):
                raise PermissionDenied
            session = OfficeSession.objects.select_related('document').get(pk=id, expires_at__gt=timezone.now())
            user = User.objects.get(pk=claims['user'], is_active=True, provider_setup_required=False)
            require(session.document, user, 'read')
            request.office_session, request.office_user = session, user
            request.office_write = claims.get('write') is True and session.document.allows(user, 'write')
            OfficeSession.objects.filter(pk=id).update(expires_at=timezone.now() + LEASE)
            return view(request, session)
        except (signing.BadSignature, PermissionDenied, Http404, User.DoesNotExist, OfficeSession.DoesNotExist, KeyError):
            return JsonResponse({'error': 'Invalid or revoked WOPI access.'}, status=403)
        except Conflict:
            return JsonResponse({'error': 'The original changed. Keep a copy of your edits.'}, status=409)
        except ValidationError as error:
            return JsonResponse({'error': '; '.join(error.messages)}, status=400)
        except (StorageError, requests.RequestException):
            return JsonResponse({'error': 'Storage is unavailable. Your edits have not been discarded.'}, status=503)
    return wrapped


def read_original(session):
    data = active_storage().read(session.document.reference)
    if active_storage().fingerprint(session.document.reference, data) != session.base_digest:
        raise Conflict('The original changed outside Collabora.')
    return data


def editor_bytes(document, data):
    """Repair older Yourwiki OPC prefixes in transit, without touching storage."""
    if extension(document) == 'md':
        from .file_formats import read_markdown
        from .native import unpack, markdown_export
        content = read_markdown(data)
        native = unpack(content)
        return (markdown_export(native['data']) if native else content).encode()
    if extension(document) not in ('docx', 'docm', 'dotx', 'dotm'):
        return data
    from .file_formats import checked_archive
    from lxml import etree
    part = 'word/_rels/document.xml.rels'
    with checked_archive(data) as source:
        rels = etree.fromstring(source.read(part), etree.XMLParser(resolve_entities=False, no_network=True))
        if rels.prefix is None:
            return data
        ns = 'http://schemas.openxmlformats.org/package/2006/relationships'
        root = etree.Element('{' + ns + '}Relationships', nsmap={None: ns}, attrib=rels.attrib)
        for child in rels:
            if child.tag != '{' + ns + '}Relationship' or len(child):
                raise ValidationError('Unsupported DOCX relationships.')
            etree.SubElement(root, child.tag, attrib=child.attrib)
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as target:
            for entry in source.infolist():
                target.writestr(entry, etree.tostring(root, encoding='utf-8', xml_declaration=True)
                                if entry.filename == part else source.read(entry.filename))
        return output.getvalue()


@wopi
@require_http_methods(['GET', 'POST'])
def wopi_info(request, session):
    if request.method == 'GET':
        doc = session.document
        data = editor_bytes(doc, read_original(session))
        return JsonResponse({'BaseFileName': PurePosixPath(storage_key(doc)).name, 'OwnerId': str(doc.owner_id),
            'Size': len(data), 'Version': doc.storage_digest, 'LastModifiedTime': doc.updated_at.isoformat(),
            'UserId': str(request.office_user.pk), 'UserFriendlyName': request.office_user.label,
            'UserCanWrite': request.office_write, 'ReadOnly': not request.office_write,
            'UserCanNotWriteRelative': True, 'SupportsRename': False, 'SupportsLocks': True,
            'SupportsGetLock': True, 'PostMessageOrigin': origin(settings.PUBLIC_URL)})
    if not request.office_write:
        raise PermissionDenied
    operation = request.headers.get('X-WOPI-Override', '')
    lock = request.headers.get('X-WOPI-Lock', '')
    if len(lock) > 1024:
        raise ValidationError('Invalid office lock.')
    with transaction.atomic():
        session = OfficeSession.objects.get(pk=session.pk)
        current = session.lock if session.lock_expires_at and session.lock_expires_at > timezone.now() else ''
        if operation == 'GET_LOCK':
            response = HttpResponse()
            response['X-WOPI-Lock'] = current
            return response
        old = request.headers.get('X-WOPI-OldLock', lock)
        conflict = (operation == 'LOCK' and current and current != old) or (operation in ('UNLOCK', 'REFRESH_LOCK') and current != lock)
        if conflict:
            response = HttpResponse(status=409)
            response['X-WOPI-Lock'] = current
            return response
        if operation not in ('LOCK', 'UNLOCK', 'REFRESH_LOCK') or (operation != 'UNLOCK' and not lock):
            return HttpResponse(status=501)
        session.lock = '' if operation == 'UNLOCK' else lock
        session.lock_expires_at = timezone.now() + LEASE
        session.save(update_fields=['lock', 'lock_expires_at'])
    return HttpResponse()


@wopi
@require_http_methods(['GET', 'POST'])
def wopi_contents(request, session):
    if request.method == 'GET':
        return HttpResponse(editor_bytes(session.document, read_original(session)), content_type=mime(extension(session.document)))
    if not request.office_write:
        raise PermissionDenied
    if request.headers.get('X-WOPI-Override') != 'PUT':
        return HttpResponse(status=501)
    payload = request.body
    validate_file(session.document, payload)
    # A rejected lock must not replace the legitimate editor's recovery copy.
    with transaction.atomic():
        session = OfficeSession.objects.get(pk=session.pk)
        lock = session.lock if session.lock_expires_at and session.lock_expires_at > timezone.now() else ''
        if lock and lock != request.headers.get('X-WOPI-Lock', ''):
            response = HttpResponse(status=409)
            response['X-WOPI-Lock'] = lock
            return response
        OfficeSession.objects.filter(pk=session.pk).update(pending=payload, pending_author=request.office_user)
    # Retain bytes before attempting a remote write. A failed transaction cannot
    # roll back this recovery copy, and an uncertain result goes through the journal.
    try:
        with transaction.atomic():
            session = OfficeSession.objects.select_related('document').get(pk=session.pk)
            document = session.document
            require(document, request.office_user, 'write')
            lock = session.lock if session.lock_expires_at and session.lock_expires_at > timezone.now() else ''
            if lock and lock != request.headers.get('X-WOPI-Lock', ''):
                response = HttpResponse(status=409)
                response['X-WOPI-Lock'] = lock
                return response
            if session.superseded or session.base_digest != document.storage_digest:
                raise Conflict('The original changed outside this office session.')
            from .saves import write_snapshot
            document.reference = write_snapshot(document, payload, storage_key(document), user=request.office_user, raw=True)
            document.revision += 1
            document.updated_at = timezone.now()
            document.save(update_fields=['reference', 'storage_digest', 'history_reference', 'revision', 'updated_at'])
            from .write_journal import acknowledge
            acknowledge(document)
            Collaboration.objects.filter(document=document).delete()
            session.base_digest = document.storage_digest
            session.pending, session.error = b'', ''
            session.save(update_fields=['base_digest', 'pending', 'error'])
        response = HttpResponse()
        response['X-WOPI-ItemVersion'] = document.storage_digest
        return response
    except Exception as error:
        OfficeSession.objects.filter(pk=session.pk).update(error=(
            'The original changed. Download your recovery copy.' if isinstance(error, Conflict)
            else 'Saving failed. Your office recovery copy is retained; retry saving.'))
        raise


OFFICE_CONFLICT = 'The original document changed. Automatic saving is paused. Copy your changes or download a recovery copy before leaving.'


def refresh_office(session):
    """Retire the old WOPI identity on external changes; never replace its recovery bytes."""
    if session.superseded:
        return
    from .models import WriteAttempt
    if WriteAttempt.objects.filter(document=session.document).exclude(state='acknowledged').exists():
        return  # Reconcile an uncertain write before accepting a new baseline.
    adapter = active_storage()
    original = session.document
    raw = adapter.read(original.reference)
    fingerprint = adapter.fingerprint(original.reference, raw)
    with transaction.atomic():
        current = OfficeSession.objects.select_related('document').get(pk=session.pk)
        doc = current.document
        if current.superseded or doc.reference != original.reference or doc.storage_digest != original.storage_digest:
            return
        if fingerprint == current.base_digest:
            return
        # This session is kept for late saves/recovery. New clients get a new
        # WOPI URL so Collabora cannot serve its cached, outdated document.
        current.superseded = True
        current.error = OFFICE_CONFLICT
        current.save(update_fields=['superseded', 'error'])
        doc.storage_digest = fingerprint
        doc.revision += 1
        doc.updated_at = timezone.now()
        doc.save(update_fields=['storage_digest', 'revision', 'updated_at'])
        Collaboration.objects.filter(document=doc, sequence=models.F('synced_sequence')).delete()


@guarded
@require_http_methods(['POST'])
def office_status(request, id):
    doc = document_for(request.user, id)
    session = OfficeSession.objects.select_related('document').filter(document=doc, pk=request.POST.get('session'), expires_at__gt=timezone.now()).first()
    if not session:
        return JsonResponse({'error': 'The office session expired. Keep a copy in Collabora before reopening.'}, status=409)
    refresh_office(session)
    session.refresh_from_db()
    OfficeSession.objects.filter(pk=session.pk).update(expires_at=timezone.now() + LEASE)
    return JsonResponse({'error': session.error, 'changed': session.superseded,
                         'write': doc.allows(request.user, 'write'),
                         'recovery': bool(session.pending) and (session.pending_author_id == request.user.pk or request.user.is_superuser)})


@guarded
@require_http_methods(['GET'])
def recovery(request, id):
    doc = document_for(request.user, id)
    sessions = OfficeSession.objects.filter(document=doc).exclude(pending=b'')
    if request.GET.get('session'):
        sessions = sessions.filter(pk=request.GET['session'])
    if not request.user.is_superuser:
        sessions = sessions.filter(pending_author=request.user)
    session = sessions.first()
    if not session or (session.pending_author_id != request.user.pk and not request.user.is_superuser):
        raise PermissionDenied
    from django.utils.http import content_disposition_header
    response = HttpResponse(bytes(session.pending), content_type=mime(extension(doc)))
    response['Content-Disposition'] = content_disposition_header(True, 'recovery.' + extension(doc))
    return response
