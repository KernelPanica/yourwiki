"""Batch-load ACL ancestry without caching permissions across requests."""
from .models import Folder, SiteConfiguration


def access_graph(user):
    groups = frozenset(str(pk) for pk in user.groups.values_list('pk', flat=True))
    site = SiteConfiguration.current()
    folders = list(Folder.all_objects.select_related('owner', 'group'))
    by_id = {folder.pk: folder for folder in folders}
    for folder in folders:
        folder._state.fields_cache['parent'] = by_id.get(folder.parent_id)
        folder._access_site = site
        folder._access_groups = (user.pk, groups)
    return folders, by_id, site


def attach_documents(documents, folders, site, user):
    groups = next(iter(folders.values()))._access_groups if folders else (user.pk, frozenset(str(pk) for pk in user.groups.values_list("pk", flat=True)))
    for document in documents:
        document._state.fields_cache['folder'] = folders.get(document.folder_id)
        document._access_site = site
        document._access_groups = groups
    return documents
