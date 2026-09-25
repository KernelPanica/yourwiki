from .models import Document

def workspace(request):
    if not getattr(request, 'user', None) or not request.user.is_authenticated:
        return {}
    visible = [d for d in Document.objects.select_related('group', 'owner') if d.allows(request.user, 'visible')]
    from .folders import accessible, directory_path, storage_path
    nodes = {f.pk: {'folder':f,'children':[], 'documents':[]} for f in accessible(request.user)}
    for node in nodes.values():
        folder = node['folder']
        folder.explorer_write = folder.allows(request.user, 'write')
        folder.explorer_move = folder.explorer_write and (not folder.parent or folder.parent.allows(request.user, 'write'))
        folder.explorer_path = directory_path(folder, request.user)
    tree = []
    from .models import SiteConfiguration, MountPoint
    mount_paths = set(MountPoint.objects.values_list('path', flat=True))
    for node in nodes.values():
        folder = node['folder']
        internal_path = '/' + storage_path(folder)
        folder.is_mount = internal_path in mount_paths
        if folder.is_mount or any(path.startswith(internal_path + '/') for path in mount_paths):
            folder.explorer_move = False
    root_files = []
    for doc in visible:
        doc.can_move = doc.allows(request.user, 'write') and (not doc.folder or doc.folder.allows(request.user, 'write'))
        if doc.folder_id in nodes:
            nodes[doc.folder_id]['documents'].append(doc)
        elif not doc.folder_id:
            root_files.append(doc)
    site = SiteConfiguration.current()
    request.site_configuration = site
    for node in nodes.values():
        parent = nodes.get(node['folder'].parent_id)
        (parent['children'] if parent else tree).append(node)
    return {'site_name':site.name, 'site_description':site.description, 'folder_tree': tree, 'root_files':root_files,
        'mount_count':len(mount_paths) or 1, 'document_count':len(visible), 'provider_label':'Mounted filesystem'}
