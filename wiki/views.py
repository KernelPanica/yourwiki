from datetime import timedelta
from functools import wraps
import hashlib
import json
import secrets
from django.conf import settings
from django.contrib import messages
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.models import Group
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import IntegrityError, OperationalError, transaction
from django.http import HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_http_methods, require_POST
from .forms import DocumentForm, InviteForm, MemberForm, RegistrationForm
from .middleware import deny
from .models import Document, Invitation, LoginAttempt, User, Workspace
from .previews import preview
from .services import Conflict, EXTENSIONS, redeem_invitation, require, save_document, validate_policy, delete_document
from .storage import StorageError, active_storage


def denied(request, *args, **kwargs):
    return deny(request)


def guarded(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        try:
            return view(request, *args, **kwargs)
        except PermissionDenied:
            return deny(request)
        except (StorageError, OperationalError):
            return failure(request, 'Storage or database is temporarily unavailable. Please try again.', 503)
        except Conflict as error:
            return failure(request, str(error), 409)
        except (ValidationError, ValueError, TypeError) as error:
            return failure(request, '; '.join(error.messages) if isinstance(error, ValidationError) else 'Invalid request.', 400)
    return wrapped


def failure(request, message, status):
    if request.path.startswith('/api/'):
        return JsonResponse({'error': message}, status=status)
    return render(request, 'wiki/error.html', {'error_title': 'Unable to complete request', 'error_message': message}, status=status)


def visible_docs(user):
    return [d for d in Document.objects.select_related('owner','group') if d.allows(user, 'visible')]


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
    return redirect('library')


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
        doc.can_move = doc.allows(request.user, 'write') and (not doc.folder or doc.folder.allows(request.user, 'write'))
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
    if doc.kind == 'file':
        return render(request, 'wiki/file.html', {'doc':doc, 'can_write':doc.allows(request.user,'write'), 'can_policy':request.user.is_superuser})
    from .collaboration import current_content
    content = current_content(doc)
    try:
        rendered = preview(doc.kind, content)
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
    initial = {'title':doc.title,'kind':doc.kind,'group':doc.group_id,'revision':doc.revision,'folder':doc.folder_id} if doc else {'group': request.user.groups.first(), 'kind':'document','content':'', 'path':request.GET.get('path', '/'),'folder':request.GET.get('folder')}
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
                saved = save_document(request.user, data['title'], data['kind'], doc.collection if doc else SiteConfiguration.current().default_collection, data['content'], data['group'], doc, data.get('revision'), source_token=source_token, folder=data.get('folder'))
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
                group = request.user.groups.first() or (Group.objects.first() if request.user.is_superuser else None)
                if not group: raise PermissionDenied
                doc = save_document(request.user, upload.name, 'file', 'Uploads', upload.read(limit+1), group, folder=folder)
            return redirect('document', id=doc.pk)
    return render(request, 'wiki/upload.html', {'form':form, 'section':'Upload file'}, status=400 if form.errors else 200)


@guarded
@require_http_methods(['GET','POST'])
def import_document(request):
    if request.method == 'POST':
        upload = request.FILES.get('file')
        is_bundle=upload and upload.name.endswith('.wiki.zip')
        if not upload or upload.size > (50 if is_bundle else 5)*1024*1024:
            raise ValidationError('Choose a file smaller than 5 MB.')
        ext = upload.name.rsplit('.',1)[-1].lower()
        kind = {'md':'document','txt':'document','csv':'table','canvas':'canvas','drawio':'drawio','xml':'drawio'}.get(ext)
        group = request.user.groups.first() or (Group.objects.first() if request.user.is_superuser else None)
        if not group: raise ValidationError('Ask an administrator to add you to a group first.')
        if is_bundle:
            from .bundles import import_bundle
            doc=import_bundle(request.user,group,upload)
            return redirect('document',id=doc.pk)
        try: content = upload.read().decode('utf-8-sig')
        except UnicodeDecodeError: raise ValidationError('File must contain UTF-8 text.')
        if ext == 'json':
            from .native import unpack
            native = unpack(content)
            kind = native.get('kind') if native else None
        if not kind: raise ValidationError('Unsupported file type.')
        doc = save_document(request.user, upload.name.rsplit('.',1)[0], kind, 'Imported', content, group)
        return redirect('document', id=doc.pk)
    return render(request,'wiki/import.html',{'section':'Import'})


@guarded
def export_document(request,id):
    doc=document_for(request.user,id)
    if doc.kind == 'file':
        from django.utils.http import content_disposition_header
        response = HttpResponse(active_storage().read(doc.reference), content_type='application/octet-stream')
        response['Content-Disposition'] = content_disposition_header(True, doc.title)
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
    native = unpack(content)
    extension = 'wiki.json' if native else EXTENSIONS[doc.kind]
    if native and request.GET.get('format') == 'plain':
        content = markdown_export(native['data']) if doc.kind == 'document' else csv_export(native['data'])
        extension = 'md' if doc.kind == 'document' else 'csv'
    response=HttpResponse(content.encode(), content_type='application/octet-stream')
    from django.utils.http import content_disposition_header
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
    if not request.user.is_superuser: raise PermissionDenied
    doc=document_for(request.user,id,'visible')
    groups=Group.objects.all() if request.user.is_superuser else request.user.groups.all()
    if request.method=='POST':
        chosen = groups.filter(pk=request.POST.get('group')).first()
        if not chosen: raise ValidationError('Choose an allowed group.')
        rules={s:{a:request.POST.get(s+'.'+a)=='on' for a in ('visible','read','write')} for s in ('owner','group','everyone')}
        with transaction.atomic():
            current = document_for(request.user,id,'visible')
            if not (request.user.is_superuser or current.owner_id==request.user.pk): raise PermissionDenied
            current.policy, current.group=rules,chosen
            current.inherit_permissions = request.POST.get('inherit_permissions') == 'on'
            current.save(update_fields=['policy','group','inherit_permissions'])
        messages.success(request,'Permissions saved.')
        return redirect('library')
    return render(request,'wiki/policy.html',{'doc':doc,'groups':groups,'rules':[(s,[(a,doc.policy[s][a]) for a in ('visible','read','write')]) for s in ('owner','group','everyone')]})


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
            return redirect('library')
    return render(request,'wiki/register.html',{'form':form},status=400 if form.errors else 200)


@guarded
@require_http_methods(['GET','POST'])
def members(request):
    if not request.user.is_superuser: raise PermissionDenied
    if request.method=='POST':
        action=request.POST.get('action','create')
        group=Group.objects.filter(pk=request.POST.get('group')).first() if action != 'create' else None
        if action == 'rename':
            name=request.POST.get('name','').strip()
            if not group or not name or len(name)>150: raise ValidationError('Provide a valid group and name.')
            group.name=name;group.save(update_fields=['name']);return redirect('groups')
        if action == 'delete':
            if not group: raise ValidationError('Choose a group.')
            if User.objects.filter(groups=group).exists() or Document.objects.filter(group=group).exists(): raise ValidationError('Remove members and document assignments before deleting this group.')
            group.delete();return redirect('groups')
        name=request.POST.get('name','').strip()
        if not name or len(name)>150: raise ValidationError('Provide a group name of at most 150 characters.')
        Group.objects.get_or_create(name=name)
        return redirect('members')
    return render(request,'wiki/members.html',{'members':User.objects.all(),'groups':Group.objects.all(),'section':'Members'})


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
            if User.objects.filter(groups=group).exists() or Document.objects.filter(group=group).exists(): raise ValidationError('Remove members and document assignments before deleting this group.')
            group.delete()
        elif action == 'create':
            name=request.POST.get('name','').strip()
            if not name or len(name)>150: raise ValidationError('Provide a group name of at most 150 characters.')
            Group.objects.get_or_create(name=name)
        else: raise ValidationError('Invalid group action.')
        return redirect('groups')
    return render(request,'wiki/groups.html',{'groups':Group.objects.all(),'section':'Groups'})


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
                person.groups.set(form.cleaned_data['groups'])
                person.invite_groups.set(form.cleaned_data['invite_groups'])
            return redirect('members')
    return render(request,'wiki/member.html',{'form':form,'person':person,'section':'Members'},status=400 if form.errors else 200)


def account(request):
    return render(request,'wiki/account.html',{'section':'Settings'})


def serialized(doc,user):
    folder = doc.folder if doc.folder_id and doc.folder.allows(user, 'visible') and doc.folder.allows(user, 'read') else None
    return {'id':str(doc.pk),'title':doc.title,'kind':doc.kind,'owner':doc.owner.username,'group':doc.group.name,'policy':doc.policy,'effective_policy':doc.effective_policy()[0],'inherit_permissions':doc.inherit_permissions,'folder':str(folder.pk) if folder else None,'format_version':doc.format_version,'revision':doc.revision,'starred':doc.starred,'updated_at':doc.updated_at.isoformat(),'access':{k:doc.allows(user,k) for k in ('visible','read','write')}}


@guarded
@require_http_methods(['GET','POST'])
def api_documents(request):
    if request.method=='GET': return JsonResponse([serialized(d,request.user) for d in visible_docs(request.user)],safe=False)
    data=json.loads(request.body)
    if not isinstance(data,dict): raise ValidationError('Use a JSON object.')
    groups=Group.objects.all() if request.user.is_superuser else request.user.groups.all()
    group=groups.filter(name=data.get('group','team')).first()
    if not group: raise PermissionDenied
    if 'collection' in data: raise ValidationError('Labels are no longer supported.')
    from .models import SiteConfiguration
    doc=save_document(request.user,data.get('title',''),data.get('kind','document'),SiteConfiguration.current().default_collection,data.get('content',''),group)
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
    if any(k in data for k in ('content','title')) and any(k in data for k in ('policy','group','starred')):
        raise ValidationError('Save content and access metadata in separate requests.')
    if 'content' in data or 'title' in data:
        if 'content' not in data: raise ValidationError('Supply the complete content with a revision when saving.')
        doc=save_document(request.user,data.get('title',doc.title),doc.kind,doc.collection,data['content'],doc.group,doc,data.get('revision'))
    if 'policy' in data or 'group' in data or 'starred' in data:
        with transaction.atomic():
            doc=document_for(request.user,id,'write')
            if 'policy' in data or 'group' in data:
                if not (request.user.is_superuser or doc.owner_id==request.user.pk): raise PermissionDenied
                if 'policy' in data: validate_policy(data['policy']); doc.policy=data['policy']
                if 'group' in data:
                    groups=Group.objects.all() if request.user.is_superuser else request.user.groups.all()
                    group=groups.filter(name=data['group']).first()
                    if not group: raise PermissionDenied
                    doc.group=group
            if 'starred' in data:
                if type(data['starred']) is not bool: raise ValidationError('Starred must be a boolean.')
                doc.starred=data['starred']
            doc.save(update_fields=['policy','group','starred'])
    return JsonResponse(serialized(doc,request.user))
