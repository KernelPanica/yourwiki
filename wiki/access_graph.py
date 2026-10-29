"""Batch-load ACL ancestry without caching permissions across requests."""
from .models import Folder, SiteConfiguration


def access_graph(user, request=None):
    cached=getattr(request, '_wiki_access_graph', None)
    if cached is not None:return cached
    groups = frozenset(str(pk) for pk in user.groups.values_list('pk', flat=True))
    site = SiteConfiguration.current()
    folders = list(Folder.all_objects.select_related('owner', 'group'))
    by_id = {folder.pk: folder for folder in folders}
    for folder in folders:
        folder._state.fields_cache['parent'] = by_id.get(folder.parent_id)
        folder._access_site = site
        folder._access_groups = (user.pk, groups)
    result=(folders, by_id, site)
    if request is not None:request._wiki_access_graph=result
    return result


def attach_documents(documents, folders, site, user):
    groups = next(iter(folders.values()))._access_groups if folders else (user.pk, frozenset(str(pk) for pk in user.groups.values_list("pk", flat=True)))
    for document in documents:
        document._state.fields_cache['folder'] = folders.get(document.folder_id)
        document._access_site = site
        document._access_groups = groups
    return documents


def access_documents(user, request=None):
    from .models import Document
    cached=getattr(request, '_wiki_access_documents', None)
    if cached is not None:return cached
    _,folders,site=access_graph(user,request)
    documents=attach_documents(list(Document.objects.select_related('group','owner')),folders,site,user)
    if request is not None:request._wiki_access_documents=documents
    return documents
