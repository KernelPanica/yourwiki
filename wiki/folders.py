"""Filesystem directories and moves across mounted providers."""
import json
from django.contrib import messages
from django.contrib.auth.models import Group
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.views.decorators.http import require_http_methods
from .models import Document, Folder
from .services import require, validate_policy
from .storage import active_storage
from .views import guarded


def accessible(user, action='read'):
    return [f for f in Folder.objects.select_related('parent', 'group', 'owner')
            if f.allows(user, 'visible') and f.allows(user, action)]


def breadcrumbs(folder, user):
    result, seen = [], set()
    while folder and folder.pk not in seen:
        seen.add(folder.pk)
        if not folder.allows(user, 'visible') or not folder.allows(user, 'read'):
            break
        result.insert(0, folder)
        folder = folder.parent
    return result


def target_folder(user, value, action='write'):
    if not value:
        return None
    folder = get_object_or_404(Folder, pk=value)
    require(folder, user, action)
    return folder


def directory_path(folder, user):
    parts, seen = [], set()
    while folder:
        if folder.pk in seen or not folder.allows(user, 'visible') or not folder.allows(user, 'read'):
            return None
        seen.add(folder.pk)
        parts.insert(0, folder.name)
        folder = folder.parent
    return '/' + '/'.join(parts)


def storage_path(folder):
    parts, seen = [], set()
    while folder:
        if folder.pk in seen:
            raise ValidationError('Invalid directory hierarchy.')
        seen.add(folder.pk)
        parts.insert(0, folder.name)
        folder = folder.parent
    return '/'.join(parts)


def validate_directory_name(name):
    reserved = {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}
    if not name or len(name) > 200 or name in ('.', '..') or name.split('.')[0].upper() in reserved or any(c in name for c in ('/', '\\', '\x00', '<', '>', ':', '"', '|', '?', '*')) or name.rstrip(' .') != name:
        raise ValidationError('Use a directory name of 1–200 characters without slashes, . or .. segments.')
    return name


def resolve_path(user, value):
    value = value.strip()
    if not value.startswith('/') or '\\' in value or '\x00' in value:
        raise ValidationError('Use an absolute directory path, such as /Projects/Notes.')
    parent = None
    for part in value.strip('/').split('/') if value.strip('/') else []:
        if not part or part in ('.', '..'):
            raise ValidationError('Use directory names without . or .. segments.')
        matches = [f for f in Folder.objects.filter(parent=parent, name=part)
                   if f.allows(user, 'visible') and f.allows(user, 'read')]
        if len(matches) != 1:
            raise ValidationError('Path unavailable or ambiguous. Choose an existing accessible directory.')
        parent = matches[0]
    if parent:
        require(parent, user, 'write')
    return parent


@guarded
@require_http_methods(['GET', 'POST'])
def create_directory(request):
    from .forms import DirectoryForm
    form = DirectoryForm(request.POST or None, user=request.user,
                         initial={'path': request.GET.get('path', '/'), 'folder':request.GET.get('folder')})
    if request.method == 'POST' and form.is_valid():
        with transaction.atomic():
            parent = target_folder(request.user, form.cleaned_data['folder']) if form.cleaned_data['folder'] else resolve_path(request.user, form.cleaned_data['path'])
            if path_depth(parent) >= 32:
                form.add_error('path', 'Directories support at most 32 nested levels.')
            elif Folder.objects.filter(parent=parent, name__iexact=form.cleaned_data['name']).exists():
                form.add_error('name', 'This name is unavailable in that directory.')
            else:
                group = request.user.groups.first() or (Group.objects.first() if request.user.is_superuser else None)
                if not group:
                    raise PermissionDenied
                folder = Folder.objects.create(name=form.cleaned_data['name'], parent=parent,
                                               owner=request.user, group=group)
                active_storage().ensure_dir(storage_path(folder))
                return redirect('folder', id=folder.pk)
    return render(request, 'wiki/new_directory.html', {'form': form, 'section': 'New directory'},
                  status=400 if form.errors else 200)


def path_depth(folder):
    depth,seen=0,set()
    while folder:
        if folder.pk in seen or depth>=32:
            raise ValidationError('Directories support at most 32 nested levels.')
        seen.add(folder.pk);depth+=1;folder=folder.parent
    return depth


def move_item(user, item, destination, rename=None):
    require(item, user, 'write')
    source = item.parent_policy
    if source:
        require(source, user, 'write')
    if destination:
        require(destination, user, 'write')
    if isinstance(item, Folder):
        from .models import MountPoint
        prefix = '/' + storage_path(item)
        if MountPoint.objects.filter(path=prefix).exists() or MountPoint.objects.filter(path__startswith=prefix + '/').exists():
            raise ValidationError('Unmount this directory and its nested mounts before moving or renaming it.')
        if Folder.objects.filter(parent=destination, name__iexact=rename or item.name).exclude(pk=item.pk).exists():
            raise ValidationError('This directory name is unavailable at the destination.')
        depth=path_depth(destination)+1
        pending=[(item,depth)]
        while pending:
            node,level=pending.pop()
            if level>32: raise ValidationError('Directories support at most 32 nested levels.')
            pending.extend((child,level+1) for child in node.children.all())
        node, seen = destination, set()
        while node:
            if node.pk == item.pk or node.pk in seen:
                raise ValidationError('A folder cannot contain itself.')
            seen.add(node.pk)
            node = node.parent
    from .services import storage_key
    adapter = active_storage()
    old_prefix = storage_path(item) if isinstance(item, Folder) else ''
    new_prefix = '/'.join(part for part in (storage_path(destination), rename or item.name) if part) if isinstance(item, Folder) else storage_path(destination)
    if isinstance(item, Folder) and new_prefix == old_prefix or isinstance(item, Document) and destination == item.folder and (rename is None or rename == item.title):
        return
    descendants = []
    directories = []
    if isinstance(item, Folder):
        pending = [item]
        while pending:
            node = pending.pop()
            directories.append(node)
            pending.extend(node.children.all())
            descendants.extend(node.documents.all())
        adapter.ensure_dir(new_prefix)
        for node in directories:
            adapter.ensure_dir(new_prefix + storage_path(node)[len(old_prefix):])
    else:
        descendants = [item]
    staged = []
    try:
        for doc in descendants:
            path = storage_path(doc.folder)
            new_dir = new_prefix + path[len(old_prefix):] if isinstance(item, Folder) else new_prefix
            key = storage_key(doc, directory=new_dir, title=rename if doc == item and isinstance(item, Document) else None)
            if new_dir:
                adapter.ensure_dir(new_dir)
            reference = adapter.write(key, adapter.read(doc.reference))
            staged.append((doc, reference))
            for attachment in doc.attachments.all():
                import secrets
                asset_key = f'{new_dir + "/" if new_dir else ""}.attachments/{attachment.pk}-{secrets.token_hex(8)}.png'
                staged.append((attachment, adapter.write(asset_key, adapter.read(attachment.reference))))
        with transaction.atomic():
            if isinstance(item, Folder):
                item.parent, item.name = destination, rename or item.name
                item.save(update_fields=['parent', 'name'])
            else:
                item.folder = destination
                item.title = rename or item.title
                item.save(update_fields=['folder', 'title'])
            for record, reference in staged:
                record.reference = reference
                if isinstance(record, Document):
                    record.path_synced = True
                    record.save(update_fields=['reference', 'path_synced'])
                else:
                    record.save(update_fields=['reference'])
    except Exception:
        for _, reference in staged:
            try:
                adapter.delete(reference)
            except Exception:
                pass
        raise


@guarded
@require_http_methods(['GET', 'POST'])
def folder_page(request, id=None):
    folder = target_folder(request.user, id, 'read')
    if request.method == 'POST':
        with transaction.atomic():
            folder = target_folder(request.user, id, 'read')
            action = request.POST.get('action', 'create')
            if action == 'create':
                if path_depth(folder)>=32:
                    raise ValidationError('Directories support at most 32 nested levels.')
                if folder:
                    require(folder, request.user, 'write')
                name = request.POST.get('name', '').strip()
                validate_directory_name(name)
                if Folder.objects.filter(parent=folder, name__iexact=name).exists():
                    raise ValidationError('This name is unavailable in that directory.')
                group = request.user.groups.first() or (Group.objects.first() if request.user.is_superuser else None)
                if not group:
                    raise PermissionDenied
                child = Folder.objects.create(name=name, parent=folder, owner=request.user, group=group)
                active_storage().ensure_dir(storage_path(child))
            elif action == 'rename' and folder:
                require(folder, request.user, 'write')
                name = request.POST.get('name', '').strip()
                validate_directory_name(name)
                if Folder.objects.filter(parent=folder.parent, name__iexact=name).exclude(pk=folder.pk).exists():
                    raise ValidationError('This name is unavailable in that directory.')
                move_item(request.user, folder, folder.parent, rename=name)
            elif action == 'delete' and folder:
                require(folder, request.user, 'write')
                if hasattr(folder, 'mountpoint'):
                    raise ValidationError('Unmount this directory before deleting it.')
                if folder.children.exists() or folder.documents.exists():
                    raise ValidationError('Move or remove the contents before deleting this folder.')
                folder.delete()
                return redirect('folders')
            else:
                raise ValidationError('Invalid folder operation.')
        return redirect('folder', id=folder.pk) if folder else redirect('folders')
    children = [f for f in accessible(request.user) if f.parent_id == (folder.pk if folder else None)]
    from .models import MountPoint
    mounts = list(MountPoint.objects.all())
    docs = [d for d in Document.objects.filter(folder=folder) if d.allows(request.user, 'visible')]
    for child in children:
        child_path = '/' + storage_path(child)
        child.is_mount = any(m.path == child_path for m in mounts)
        child.can_move = child.allows(request.user, 'write') and (not child.parent or child.parent.allows(request.user, 'write')) and not any(m.path == child_path or m.path.startswith(child_path + '/') for m in mounts)
        child.can_drop = child.allows(request.user, 'write')
        child.drop_path = directory_path(child, request.user)
    for doc in docs:
        doc.can_move = doc.allows(request.user, 'write') and (not folder or folder.allows(request.user, 'write'))
    current = '/' + storage_path(folder)
    current_mount = max((m for m in mounts if m.path == '/' or current == m.path or current.startswith(m.path + '/')), key=lambda m:len(m.path), default=None)
    mount_locked = any(m.path == current or m.path.startswith(current + '/') for m in mounts)
    mount_path = directory_path(current_mount.folder, request.user) if current_mount else '/'
    return render(request, 'wiki/folders.html', {'folder': folder, 'folders': children, 'docs': docs, 'current_mount':current_mount, 'current_mount_path':mount_path or 'Shared mount', 'mount_locked':mount_locked,
        'current_path': directory_path(folder, request.user), 'breadcrumbs': breadcrumbs(folder, request.user), 'can_write': not folder or folder.allows(request.user, 'write'), 'section': 'Directories'})


@guarded
@require_http_methods(['GET', 'POST'])
def move(request, kind, id):
    model = Folder if kind == 'folder' else Document if kind == 'document' else None
    if model is None:
        raise ValidationError('Invalid item type.')
    item = get_object_or_404(model, pk=id)
    require(item, request.user, 'write')
    if request.method == 'POST':
        with transaction.atomic():
            item = model.objects.get(pk=id)
            move_item(request.user, item, target_folder(request.user, request.POST.get('destination')))
        messages.success(request, 'Moved. Inherited permissions now follow the destination.')
        if request.headers.get('Accept') == 'application/json':
            destination = item.parent if isinstance(item, Folder) else item.folder
            return JsonResponse({'moved': True, 'url': reverse('folder', args=[destination.pk]) if destination else reverse('folders')})
        return redirect('folders')
    choices=accessible(request.user,'write')
    policies={'':{'group':item.group.name,'policy':item.policy}}
    for folder in choices:
        rules,group_id=folder.effective_policy()
        policies[str(folder.pk)]={'group':Group.objects.get(pk=group_id).name,'policy':rules}
        folder.display_path = directory_path(folder, request.user) or f'Shared directory: {folder.name}'
    return render(request, 'wiki/move.html', {'item': item, 'folders': choices,'move_policies':policies})


@guarded
@require_http_methods(['GET', 'POST'])
def folder_policy(request, id):
    if not request.user.is_superuser: raise PermissionDenied
    folder = target_folder(request.user, id, 'visible')
    groups = Group.objects.all() if request.user.is_superuser else request.user.groups.all()
    if request.method == 'POST':
        folder.inherit_permissions = request.POST.get('inherit_permissions') == 'on'
        folder.policy = {s: {a: request.POST.get(s+'.'+a) == 'on' for a in ('visible','read','write')} for s in ('owner','group','everyone')}
        folder.group_policies = {str(group.pk): {a: request.POST.get(f'group.{group.pk}.{a}') == 'on' for a in ('visible','read','write')} for group in groups}
        primary = groups.filter(pk=request.POST.get('group')).first() or folder.group
        folder.group = primary
        folder.save(update_fields=['group', 'inherit_permissions', 'policy', 'group_policies'])
        return redirect('folder', id=folder.pk)
    group_rows = [(group, folder.group_policies.get(str(group.pk), {})) for group in groups]
    return render(request, 'wiki/policy.html', {'doc': folder, 'groups': groups, 'group_rows':group_rows,
        'rules': [(s, list(rule.items())) for s, rule in folder.policy.items()]})


@guarded
@require_http_methods(['GET'])
def api_folders(request):
    allowed = accessible(request.user)
    ids = {f.pk for f in allowed}
    return JsonResponse([{'id': str(f.pk), 'name': f.name, 'parent': str(f.parent_id) if f.parent_id in ids else None,
        'access': {a: f.allows(request.user, a) for a in ('visible','read','write')}} for f in allowed], safe=False)
