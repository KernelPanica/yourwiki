from datetime import timedelta
from functools import wraps
import hashlib
import json
import logging
import secrets
from django.conf import settings
from django.contrib import messages
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.models import Group
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import IntegrityError, OperationalError, transaction
from django.http import HttpResponse, JsonResponse, Http404
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_http_methods, require_POST
from .forms import DocumentForm, InviteForm, MemberForm, RegistrationForm
from .middleware import deny
from .models import Document, Invitation, LoginAttempt, User, Workspace
from .previews import preview, image_type
from .acl import normalize_policy, normalize_rule, ResourcePermissionDenied
from .services import Conflict, EXTENSIONS, redeem_invitation, require, save_document, validate_policy, delete_document
from .storage import StorageError, active_storage

log = logging.getLogger('wiki.actions')


def denied(request, *args, **kwargs):
    return deny(request)


def csrf_failure(request, reason=''):
    # Keep the site's existing denial status; disclose no CSRF internals.
    response = failure(request, 'Your session expired. Reload the page before submitting again.', 500)
    response['X-Yourwiki-Error'] = 'csrf'
    return response


@require_POST
def set_language(request):
    from django.conf import settings
    language = request.POST.get('language', '')
    if language not in dict(settings.LANGUAGES):
        return deny(request, 'invalid_language')
    next_url = request.POST.get('next', '/')
    if not next_url.startswith('/') or next_url.startswith('//'):
        next_url = '/'
    response = redirect(next_url)
    response.set_cookie(settings.LANGUAGE_COOKIE_NAME, language, max_age=settings.LANGUAGE_COOKIE_AGE, path=settings.LANGUAGE_COOKIE_PATH)
    return response


def guarded(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        try:
            return view(request, *args, **kwargs)
        except Http404:
            return failure(request, 'Not found.', 404)
        except ResourcePermissionDenied:
            return failure(request, 'Access denied.', 403)
        except PermissionDenied:
            return deny(request)
        except StorageError as error:
            return failure(request, str(error), 503)
        except OperationalError:
            return failure(request, 'Storage or database is temporarily unavailable. Please try again.', 503)
        except Conflict as error:
            return failure(request, str(error), 409)
        except (ValidationError, ValueError, TypeError) as error:
            return failure(request, '; '.join(error.messages) if isinstance(error, ValidationError) else 'Invalid request.', 400)
        except Exception:
            log.exception('Action failed: %s %s', request.method, request.path)
            return failure(request, 'The request could not be completed. Check whether the action finished before retrying.', 500)
    return wrapped


def failure(request, message, status):
    if request.path.startswith('/api/') or 'application/json' in request.headers.get('Accept', ''):
        return JsonResponse({'error': message}, status=status)
    return render(request, 'wiki/error.html', {'error_title': 'Unable to complete request', 'error_message': message}, status=status)


def visible_docs(user):
    return [d for d in Document.objects.select_related('owner','group') if d.allows(user, 'read')]


def document_for(user, id, action='read'):
    doc = get_object_or_404(Document.objects.select_related('owner','group'), pk=id)
    require(doc, user, action)
    return doc


def health(request):
    try:
        ready = Workspace.objects.filter(pk=1, initialized=True).exists()
    except OperationalError:
        ready = False
    return JsonResponse({'status': 'ok' if ready else 'not ready'}, status=200 if ready else 503)


@guarded
@require_http_methods(['GET','POST'])
def sign_in(request):
    if request.method == 'GET':
        return render(request, 'wiki/login.html')
    username = request.POST.get('username','')[:150]
    key = hashlib.sha256(username.casefold().encode()).hexdigest()
    now = timezone.now()
    from .models import SiteConfiguration
    site = SiteConfiguration.current()
    with transaction.atomic():
        attempt, _ = LoginAttempt.objects.get_or_create(key=key)
        if attempt.started_at < now-timedelta(minutes=site.login_window_minutes):
            attempt.count, attempt.started_at = 0, now
        if attempt.count >= site.login_attempts:
            return deny(request, 'login_throttled')
        attempt.count += 1
        attempt.save()
    user = authenticate(request, username=username, password=request.POST.get('password',''))
    if user is None:
        return deny(request, 'invalid_login')
    LoginAttempt.objects.filter(key=key).delete()
    login(request, user)
    request.session.set_expiry(site.session_hours * 3600)
    return redirect('folders')


@require_POST
def sign_out(request):
    logout(request)
    return redirect('login')


@guarded
def library(request):
    docs = visible_docs(request.user)
    from .folders import directory_path
    for doc in docs:
        doc.location = directory_path(doc.folder, request.user) or ('Shared file' if doc.folder_id else '/')
        doc.can_write = doc.allows(request.user, 'write')
        doc.can_move = doc.can_write and (not doc.folder or doc.folder.allows(request.user, 'write'))
    section = request.GET.get('section', 'All documents')
    if section == 'Shared':
        section = 'All documents'
    q = request.GET.get('q', '').strip()
    kind = request.GET.get('kind','')
    if section == 'Starred': docs = [d for d in docs if d.starred]
    quick = [d for d in docs if d.starred][:3]
    if q: docs = [d for d in docs if q.casefold() in d.title.casefold()]
    if kind: docs = [d for d in docs if d.kind == kind]
    return render(request, 'wiki/library.html', {'docs':docs, 'quick':quick, 'section':section, 'query':q, 'kind':kind, 'kinds':Document.KINDS, 'grid':request.GET.get('view')=='grid'})


@guarded
def detail(request, id):
    doc = document_for(request.user, id)
    if doc.kind == 'file' and doc.title.lower().endswith('.pdf'):
        with transaction.atomic():
            doc=document_for(request.user,id)
            raw=active_storage().read(doc.reference)
            fingerprint=active_storage().fingerprint(doc.reference,raw)
            if fingerprint!=doc.storage_digest:
                if doc.storage_digest:doc.revision+=1
                doc.storage_digest=fingerprint
                doc.save(update_fields=['storage_digest','revision'])
        from .pdf_layers import layer_state
        return render(request, 'wiki/pdf.html', {'doc': doc, 'section':doc.title, 'can_write': doc.allows(request.user, 'write'),
            'pdf_bootstrap': {'id': str(doc.pk), 'title': doc.title, 'revision': doc.revision,
                'layer_state': layer_state(doc, raw), 'write': doc.allows(request.user, 'write')}})
    if doc.kind == 'file':
        return render(request, 'wiki/file.html', {'doc':doc, 'is_image':bool(image_type(active_storage().read(doc.reference))), 'can_write':doc.allows(request.user,'write'), 'can_policy':request.user.is_superuser})
    from .collaboration import current_content
    content = current_content(doc)
    try:
        rendered = {'drawio_source': content} if doc.kind == 'drawio' else preview(doc.kind, content)
    except Exception:
        rendered = {'preview_error': 'Preview unavailable. You can export the original file or edit its source.'}
    return render(request, 'wiki/document.html', {'doc':doc, 'can_write':doc.allows(request.user,'write'), 'can_policy':request.user.is_superuser, **rendered})


@guarded
@require_http_methods(['GET','POST'])
def editor(request, id=None):
    doc = document_for(request.user, id, 'write') if id else None
    if doc: require(doc, request.user, 'read')
    if doc and doc.kind == 'file': return redirect('document', id=doc.pk)
    source_token = None
    if doc and request.GET.get('source'):
        from .source import acquire, release
        key = 'source:'+str(doc.pk)
        if request.method == 'POST' and request.POST.get('cancel_source'):
            release(doc,request.user,request.session.get(key))
            request.session.pop(key,None)
            return redirect('document',id=doc.pk)
        source_token = acquire(doc,request.user,request.session.get(key)) if request.method == 'GET' else request.session.get(key)
        request.session[key] = source_token
    if doc and request.method == 'GET' and not request.GET.get('source'):
        from .editor_views import live
        return live(request, id)
    initial = {'file_format':doc.file_format if doc.file_format in ('md','docx') else 'md','title':doc.title,'kind':doc.kind,'group':doc.group_id,'revision':doc.revision,'folder':doc.folder_id} if doc else {'group': request.user.groups.first(), 'kind':'document','content':'', 'path':request.GET.get('path', '/'),'folder':request.GET.get('folder')}
    if doc and request.method == 'GET':
        from .collaboration import current_content
        initial['content'] = current_content(doc)
    form = DocumentForm(request.POST or None, user=request.user, editing=bool(doc), initial=initial)
    # Owners may retain an assigned group they no longer belong to while editing.
    if doc:
        form.fields['group'].queryset = Group.objects.filter(pk=doc.group_id)
        from .models import Folder
        form.fields['folder'].queryset = Folder.objects.filter(pk=doc.folder_id)
    status = 200
    if request.method == 'POST':
        if form.is_valid():
            try:
                data = form.cleaned_data
                if not doc and data['content'] in ('', '# New document\n\nStart writing here.'):
                    data['content'] = {'file':'', 'document':'', 'table':'', 'canvas':'{"nodes":[],"edges":[]}', 'drawio':'<mxfile><diagram id="page1" name="Page 1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>'}[data['kind']]
                if not doc and data.get('folder'):
                    require(data['folder'], request.user, 'write')
                from .models import SiteConfiguration
                with transaction.atomic():
                    saved = save_document(request.user, data['title'], data['kind'], doc.collection if doc else SiteConfiguration.current().default_collection, data['content'], data['group'], doc, data.get('revision'), source_token=source_token, folder=data.get('folder'), file_format=data.get('file_format') or None)
                    if not doc:
                        form.apply_permissions(saved)
                messages.success(request, 'Document saved.')
                return redirect('document' if saved.kind == 'file' else 'live', id=saved.pk)
            except (ValidationError, Conflict, StorageError, OperationalError) as error:
                message = '; '.join(error.messages) if isinstance(error,ValidationError) else str(error) if isinstance(error,(Conflict,StorageError)) else 'Database busy. Please retry.'
                form.add_error(None, message)
                status = 409 if isinstance(error, Conflict) else 503 if isinstance(error,(StorageError,OperationalError)) else 400
        else: status=400
    return render(request, 'wiki/editor.html', {'form':form,'doc':doc,'section':'Edit document' if doc else 'New document'}, status=status)


@guarded
@require_http_methods(['GET','POST'])
def upload_file(request):
    from .forms import UploadForm
    from .folders import resolve_path
    from .models import SiteConfiguration
    form = UploadForm(request.POST or None, request.FILES or None, user=request.user,
                      initial={'path':request.GET.get('path', '/'), 'folder':request.GET.get('folder')})
    if request.method == 'POST' and form.is_valid():
        upload = form.cleaned_data['file']
        limit = min(5, SiteConfiguration.current().document_limit_mb)*1024*1024
        if upload.size > limit:
            form.add_error('file', f'Choose a file no larger than {limit//(1024*1024)} MB.')
        else:
            with transaction.atomic():
                from .folders import target_folder
                folder = target_folder(request.user, form.cleaned_data['folder']) if form.cleaned_data['folder'] else resolve_path(request.user, form.cleaned_data['path'])
                group = folder.group if folder else request.user.groups.first() or (Group.objects.first() if request.user.is_superuser else None)
                if not group: raise PermissionDenied
                if upload.name.lower().endswith('.docx'):
                    from .file_formats import read_docx as to_native
                    doc = save_document(request.user, upload.name[:-5], 'document', 'Uploads', to_native(upload.read()), group, folder=folder, file_format='docx')
                elif upload.name.lower().endswith('.ods'):
                    from .file_formats import read_ods
                    doc = save_document(request.user, upload.name[:-4], 'table', 'Uploads', read_ods(upload.read()), group, folder=folder)
                else:
                    content = upload.read(limit+1)
                    if upload.name.lower().endswith('.pdf'):
                        from .pdf import process_pdf
                        process_pdf(content)
                    doc = save_document(request.user, upload.name, 'file', 'Uploads', content, group, folder=folder)
                form.apply_permissions(doc)
            return redirect('document', id=doc.pk)
    if request.method == 'POST' and form.errors and 'application/json' in request.headers.get('Accept', ''):
        return JsonResponse({'error':'Check the highlighted fields.', 'errors':form.errors.get_json_data()}, status=400)
    return render(request, 'wiki/upload.html', {'form':form, 'section':'Upload file'}, status=400 if form.errors else 200)


@guarded
@require_http_methods(['GET','POST'])
def import_document(request):
    if request.method == 'POST':
        upload = request.FILES.get('file')
        is_bundle=upload and upload.name.endswith('.wiki.zip')
        is_recovery=upload and upload.name.endswith('.recovery.json')
        if not upload or upload.size > (50 if is_bundle else 20 if is_recovery else 5)*1024*1024:
            raise ValidationError('Choose a file smaller than 5 MB.')
        ext = upload.name.rsplit('.',1)[-1].lower()
        kind = {'md':'document','txt':'document','csv':'table','ods':'table','canvas':'canvas','drawio':'drawio','xml':'drawio','doc':'file','docx':'file','pdf':'file'}.get(ext)
        group = request.user.groups.first() or (Group.objects.first() if request.user.is_superuser else None)
        if not group: raise ValidationError('Ask an administrator to add you to a group first.')
        if is_recovery:
            from .recovery import decode_snapshot
            kind,content,file_format=decode_snapshot(upload.read())
            doc=save_document(request.user,upload.name[:-14]+' (recovered)',kind,'Imports',content,group,file_format=file_format)
            return redirect('document',id=doc.pk)
        if is_bundle:
            from .bundles import import_bundle
            doc=import_bundle(request.user,group,upload)
            return redirect('document',id=doc.pk)
        if ext == 'docx':
            from .file_formats import read_docx as to_native
            content = to_native(upload.read())
            kind = 'document'
        elif ext == 'ods':
            from .file_formats import read_ods
            content = read_ods(upload.read())
        elif ext in ('md', 'txt'):
            from .file_formats import read_markdown
            content = read_markdown(upload.read())
        elif ext == 'pdf':
            from .pdf import process_pdf
            content = upload.read()
            process_pdf(content)
        elif kind == 'file':
            content = upload.read()
        else:
            try: content = upload.read().decode('utf-8-sig')
            except UnicodeDecodeError: raise ValidationError('File must contain UTF-8 text.')
        if ext == 'json':
            from .native import unpack
            native = unpack(content)
            kind = native.get('kind') if native else None
        if not kind: raise ValidationError('Unsupported file type.')
        title = upload.name if kind == 'file' else upload.name.rsplit('.',1)[0]
        doc = save_document(request.user, title, kind, 'Imported', content, group, file_format=ext if ext in ('md', 'docx') else None)
        return redirect('document', id=doc.pk)
    return render(request,'wiki/import.html',{'section':'Import'})


@guarded
def export_document(request,id):
    doc=document_for(request.user,id)
    if doc.kind == 'file':
        from django.utils.http import content_disposition_header
        content = active_storage().read(doc.reference)
        is_pdf = doc.title.lower().endswith('.pdf') and content.startswith(b'%PDF-')
        if is_pdf and request.GET.get('original') != '1':
            from .pdf_layers import saved_pdf
            content = saved_pdf(doc, earlier_annotations=request.GET.get('annotations') == '1')
        mime = 'application/pdf' if is_pdf else image_type(content)
        response = HttpResponse(content, content_type=mime or 'application/octet-stream')
        response['Content-Disposition'] = content_disposition_header(not (mime and request.GET.get('inline') == '1'), doc.title)
        response['X-Content-Type-Options'] = 'nosniff'
        return response
    if request.GET.get('format') == 'bundle':
        from .bundles import export_bundle
        from django.utils.http import content_disposition_header
        response=HttpResponse(export_bundle(doc),content_type='application/zip')
        response['Content-Disposition']=content_disposition_header(True,doc.title+'.wiki.zip')
        return response
    from .collaboration import current_content
    from .native import unpack, markdown_export, csv_export
    content = current_content(doc)
    from django.utils.http import content_disposition_header
    if request.GET.get('format') == 'docx' and doc.kind == 'document':
        from .file_formats import encode
        doc.file_format = 'docx'
        response = HttpResponse(encode(doc, content), content_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        response['Content-Disposition'] = content_disposition_header(True, doc.title + '.docx')
        return response
    if request.GET.get('format') == 'pdf' and doc.kind == 'document':
        from .pdf import to_pdf
        response = HttpResponse(to_pdf(content, doc.title), content_type='application/pdf')
        response['Content-Disposition'] = content_disposition_header(True, doc.title + '.pdf')
        return response
    if doc.file_format and request.GET.get('format') != 'plain':
        from .file_formats import encode, MIMES
        response = HttpResponse(encode(doc, content), content_type=MIMES.get(doc.file_format, 'application/octet-stream'))
        response['Content-Disposition'] = content_disposition_header(True, doc.title + '.' + doc.file_format)
        return response
    native = unpack(content)
    extension = 'wiki.json' if native else EXTENSIONS[doc.kind]
    if native and request.GET.get('format') == 'plain':
        content = markdown_export(native['data']) if doc.kind == 'document' else csv_export(native['data'])
        extension = 'md' if doc.kind == 'document' else 'csv'
    response=HttpResponse(content.encode(), content_type='application/octet-stream')
    response['Content-Disposition']=content_disposition_header(True, doc.title+'.'+extension)
    return response


@guarded
@require_POST
def star(request,id):
    with transaction.atomic():
        doc=document_for(request.user,id,'write')
        doc.starred=not doc.starred
        doc.save(update_fields=['starred'])
    return redirect('library')


@guarded
@require_http_methods(['GET','POST'])
def remove(request,id):
    doc=document_for(request.user,id,'write')
    if request.method=='POST':
        if not delete_document(request.user, doc):
            messages.info(request, 'Document removed from the wiki. Storage cleanup will retry automatically.')
        return redirect('library')
    return render(request,'wiki/delete.html',{'doc':doc})


@guarded
@require_http_methods(['GET','POST'])
def policy(request,id):
    # Keep bookmarked URLs, but only one settings form owns ACL mutation.
    document_for(request.user, id)
    return redirect(reverse('file-settings', args=[id]) + '#access')


@guarded
def permissions(request):
    if not request.user.is_superuser: raise PermissionDenied
    return render(request,'wiki/permissions.html',{'docs':visible_docs(request.user),'section':'Permissions'})


@guarded
@require_http_methods(['GET','POST'])
def invitations(request):
    user=request.user
    if not (user.is_superuser or user.can_invite): raise PermissionDenied
    form=InviteForm(request.POST or None,user=user)
    link=None
    if request.method=='POST' and form.is_valid():
        token=secrets.token_urlsafe(32)
        with transaction.atomic():
            invitation=Invitation.objects.create(token_hash=Invitation.digest(token),creator=user,max_uses=form.cleaned_data['max_uses'],expires_at=timezone.now()+timedelta(days=form.cleaned_data['days']) if form.cleaned_data['days'] else None)
            invitation.groups.set(form.cleaned_data['groups'])
        link=settings.PUBLIC_URL+reverse('redeem',args=[token])
        form=InviteForm(user=user)
    items=Invitation.objects.all() if user.is_superuser else Invitation.objects.filter(creator=user)
    return render(request,'wiki/invitations.html',{'form':form,'items':items.order_by('-created_at'),'invite_link':link,'section':'Invitations'},status=400 if form.errors else 200)


@guarded
@require_POST
def revoke(request,id):
    invitation=get_object_or_404(Invitation,pk=id)
    if not (request.user.is_superuser or request.user.can_invite and invitation.creator_id==request.user.pk): raise PermissionDenied
    invitation.revoked=True; invitation.save(update_fields=['revoked'])
    return redirect('invitations')


@guarded
@require_http_methods(['GET','POST'])
def redeem(request,token):
    invitation=Invitation.objects.filter(token_hash=Invitation.digest(token)).first()
    if not invitation or not invitation.valid(): raise PermissionDenied
    creator=invitation.creator
    if not creator.is_active or not (creator.is_superuser or creator.can_invite): raise PermissionDenied
    if not creator.is_superuser and invitation.groups.exclude(pk__in=creator.invite_groups.values('pk')).exists(): raise PermissionDenied
    form=RegistrationForm(request.POST or None)
    if request.method=='POST' and form.is_valid():
        try:
            user=redeem_invitation(token,form.save(commit=False))
        except IntegrityError:
            form.add_error('username','That username is already taken.')
        else:
            login(request,user)
            from .models import SiteConfiguration
            request.session.set_expiry(SiteConfiguration.current().session_hours * 3600)
            return redirect('provider-setup')
    return render(request,'wiki/register.html',{'form':form},status=400 if form.errors else 200)


@guarded
@require_http_methods(['GET'])
def members(request):
    if not request.user.is_superuser: raise PermissionDenied
    return render(request,'wiki/members.html',{'members':User.objects.prefetch_related('groups').order_by('username'),'section':'Members'})


@guarded
@require_http_methods(['GET','POST'])
def groups(request):
    if not request.user.is_superuser: raise PermissionDenied
    if request.method == 'POST':
        action=request.POST.get('action')
        group=Group.objects.filter(pk=request.POST.get('group')).first()
        if action == 'rename' and group:
            name=request.POST.get('name','').strip()
            if not name or len(name)>150: raise ValidationError('Provide a group name of at most 150 characters.')
            group.name=name;group.save(update_fields=['name'])
        elif action == 'delete' and group:
            if User.objects.filter(groups=group).exists() or Document.objects.filter(group=group).exists() or group.folder_set.exists(): raise ValidationError('Remove members and document assignments before deleting this group.')
            group.delete()
        elif action == 'create':
            name=request.POST.get('name','').strip()
            if not name or len(name)>150: raise ValidationError('Provide a group name of at most 150 characters.')
            Group.objects.get_or_create(name=name)
        else: raise ValidationError('Invalid group action.')
        return redirect('groups')
    return render(request,'wiki/groups.html',{'groups':Group.objects.prefetch_related('user_set', 'folder_set').order_by('name'),'section':'Groups'})


@guarded
@require_http_methods(['GET','POST'])
def group_detail(request, id):
    if not request.user.is_superuser: raise PermissionDenied
    from .forms import GroupMembershipForm
    group = get_object_or_404(Group, pk=id)
    form = GroupMembershipForm(request.POST or None, group=group,
        initial={'name':group.name, 'members':group.user_set.all()})
    if request.method == 'POST' and form.is_valid():
        with transaction.atomic():
            group.name = form.cleaned_data['name']
            group.save(update_fields=['name'])
            group.user_set.set(form.cleaned_data['members'])
        messages.success(request, 'Group saved.')
        return redirect('group', id=group.pk)
    return render(request, 'wiki/group.html', {'form':form, 'group':group, 'section':'Groups'}, status=400 if form.errors else 200)


@guarded
@require_http_methods(['GET','POST'])
def member(request,id):
    if not request.user.is_superuser: raise PermissionDenied
    person=get_object_or_404(User,pk=id)
    form=MemberForm(request.POST or None,initial={'display_name':person.label,'is_active':person.is_active,'can_invite':person.can_invite,'groups':person.groups.all(),'invite_groups':person.invite_groups.all()})
    if request.method=='POST' and form.is_valid():
        if person.is_superuser and not form.cleaned_data['is_active']:
            form.add_error('is_active','Administrator accounts cannot be disabled here.')
        else:
            with transaction.atomic():
                for key in ('display_name','is_active','can_invite'): setattr(person,key,form.cleaned_data[key])
                person.save()
                person.invite_groups.set(form.cleaned_data['invite_groups'])
            return redirect('members')
    return render(request,'wiki/member.html',{'form':form,'person':person,'section':'Members'},status=400 if form.errors else 200)


def account(request):
    return render(request,'wiki/account.html',{'section':'Settings'})


def serialized(doc,user):
    folder = doc.folder if doc.folder_id and doc.folder.allows(user, 'read') else None
    return {'id':str(doc.pk),'title':doc.title,'kind':doc.kind,'owner':doc.owner.username,'group':doc.group.name,'policy':normalize_policy(doc.policy),'group_policies':{key:normalize_rule(rule) for key,rule in doc.group_policies.items()},'effective_policy':doc.effective_policy()[0],'inherit_permissions':doc.inherit_permissions,'folder':str(folder.pk) if folder else None,'file_format':doc.file_format,'format_version':doc.format_version,'revision':doc.revision,'starred':doc.starred,'updated_at':doc.updated_at.isoformat(),'access':{k:doc.allows(user,k) for k in ('read','write')}}


@guarded
@require_http_methods(['GET','POST'])
def api_documents(request):
    if request.method=='GET': return JsonResponse([serialized(d,request.user) for d in visible_docs(request.user)],safe=False)
    data=json.loads(request.body)
    if not isinstance(data,dict): raise ValidationError('Use a JSON object.')
    from .folders import target_folder, resolve_path
    from .models import SiteConfiguration
    if 'collection' in data: raise ValidationError('Labels are no longer supported.')
    if any(key in data for key in ('policy','group_policies','inherit_permissions')):
        raise ValidationError('New files inherit access. Use file settings to change permissions.')
    with transaction.atomic():
        folder = target_folder(request.user,data.get('folder')) if data.get('folder') else resolve_path(request.user,data.get('path','/'))
        group = folder.group if folder else request.user.groups.first() or (Group.objects.first() if request.user.is_superuser else None)
        if not group: raise PermissionDenied
        doc=save_document(request.user,data.get('title',''),data.get('kind','document'),SiteConfiguration.current().default_collection,data.get('content',''),group,folder=folder,file_format=data.get('file_format'))
    return JsonResponse(serialized(doc,request.user),status=201)


@guarded
@require_http_methods(['GET','PUT','DELETE'])
def api_document(request,id):
    doc=document_for(request.user,id,'read' if request.method=='GET' else 'write')
    if request.method=='GET':
        from .collaboration import current_content
        if doc.kind == 'file':
            return JsonResponse({**serialized(doc,request.user), 'download_url':reverse('export', args=[doc.pk])})
        return JsonResponse({**serialized(doc,request.user),'content':current_content(doc)})
    if request.method=='DELETE':
        complete = delete_document(request.user, doc)
        return JsonResponse({'deleted': True, 'storage_cleanup_pending': not complete}, status=200 if complete else 202)
    data=json.loads(request.body)
    if not isinstance(data,dict): raise ValidationError('Use a JSON object.')
    if 'collection' in data: raise ValidationError('Labels are no longer supported.')
    if any(k in data for k in ('content','title')) and any(k in data for k in ('policy','group','group_policies','inherit_permissions','starred')):
        raise ValidationError('Save content and access metadata in separate requests.')
    if 'content' in data or 'title' in data:
        if 'content' not in data: raise ValidationError('Supply the complete content with a revision when saving.')
        doc=save_document(request.user,data.get('title',doc.title),doc.kind,doc.collection,data['content'],doc.group,doc,data.get('revision'))
    if {'policy','group','group_policies','inherit_permissions','starred'} & data.keys():
        from .acl import apply_api_access
        with transaction.atomic():
            doc=document_for(request.user,id,'write')
            fields = apply_api_access(doc,data,request.user)
            if 'starred' in data:
                if type(data['starred']) is not bool: raise ValidationError('Starred must be a boolean.')
                doc.starred=data['starred'];fields.append('starred')
            doc.save(update_fields=fields)
    return JsonResponse(serialized(doc,request.user))


@guarded
@require_POST
def save_pdf(request, id):
    from .pdf import process_pdf
    from .models import SiteConfiguration
    doc = document_for(request.user, id, 'write')
    require(doc, request.user, 'read')
    if doc.kind != 'file' or not doc.title.lower().endswith('.pdf'):
        raise ValidationError('Choose a PDF file.')
    upload = request.FILES.get('file')
    if not upload or upload.size > min(5, SiteConfiguration.current().document_limit_mb) * 1024 * 1024:
        raise ValidationError('Use a PDF file no larger than 5 MB.')
    content = upload.read()
    process_pdf(content)
    from .saves import stage
    from .pdf_layers import commit_layer
    client_id=request.POST.get('client_id') or 'default'
    session=stage(doc,request.user,content,f'pdf:{request.user.pk}:{client_id}',int(request.POST.get('revision','0')))
    try:
        commit_layer(session.pk, replace_stale_layer=request.POST.get('replace_stale_layer') == '1')
    except OSError:
        return failure(request, 'Annotation storage is unavailable. Your pending edits are retained.', 503)
    session.refresh_from_db()
    return JsonResponse({'revision': session.saved_revision})


@guarded
@require_http_methods(['GET', 'POST'])
def file_settings(request, id):
    doc = document_for(request.user, id, 'write')
    from .acl import settings_context, save_settings_access
    if request.method == 'POST' and request.POST.get('action') == 'access':
        with transaction.atomic():
            doc = document_for(request.user,id,'write')
            save_settings_access(doc,request.POST,request.user)
        return redirect(reverse('file-settings',args=[id])+'#access')
    if request.method == 'POST' and request.POST.get('action') == 'reload':
        if request.POST.get('discard') != 'on':
            raise ValidationError('Export your edits and confirm discarding the local editor state first.')
        from .realtime import connections
        from .source import check_available
        from .file_formats import decode
        from .models import Collaboration
        with transaction.atomic():
            doc = document_for(request.user, id, 'write')
            check_available(doc)
            if connections.get(str(doc.pk)):
                raise Conflict('Close active visual editors before reloading the original.')
            raw = active_storage().read(doc.reference)
            if doc.kind != 'file': decode(doc, raw)
            from .write_journal import discard
            discard(doc)
            Collaboration.objects.filter(document=doc).delete()
            from .models import SaveSession
            SaveSession.objects.filter(document=doc).delete()
            doc.storage_digest = active_storage().fingerprint(doc.reference, raw)
            doc.revision += 1
            doc.save(update_fields=['storage_digest', 'revision'])
        return redirect('document', id=doc.pk)

    if request.method == 'POST':
        raise ValidationError('Version history is controlled globally in site settings.')
    return render(request, 'wiki/file_settings.html', {'doc': doc, 'history_enabled': doc.history_enabled(), **settings_context(doc,request.user)})


@guarded
@require_http_methods(['GET'])
def file_history(request, id):
    doc = document_for(request.user, id)
    if not doc.history_reference:
        raise ValidationError('This file has no saved history.')
    from django.utils.http import content_disposition_header
    from .storage import HISTORY_MAX_BYTES
    response = HttpResponse(active_storage().read(doc.history_reference, limit=HISTORY_MAX_BYTES), content_type='application/json')
    response['Content-Disposition'] = content_disposition_header(True, doc.title + '.' + (doc.file_format or 'file') + '.json')
    return response


@guarded
@require_http_methods(['GET', 'PUT'])
def api_file_content(request, id):
    """Binary read/write for every provider, through the same authorization gate."""
    doc = document_for(request.user,id,'read' if request.method=='GET' else 'write')
    if request.method == 'GET':
        response = export_document(request,id)
        response['ETag'] = f'"{doc.revision}"'
        return response
    if doc.kind != 'file':
        raise ValidationError('Use the document content API for editable documents.')
    expected = request.headers.get('If-Match','').strip('"')
    if not expected.isdigit():
        raise ValidationError('Supply the current revision in If-Match.')
    content=request.body
    if doc.title.lower().endswith('.pdf'):
        from .pdf import process_pdf
        process_pdf(content)
    doc=save_document(request.user,doc.title,doc.kind,doc.collection,content,doc.group,doc,int(expected))
    response=JsonResponse(serialized(doc,request.user))
    response['ETag']=f'"{doc.revision}"'
    return response
