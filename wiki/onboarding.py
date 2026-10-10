"""Resolve cloud accounts needed by the user's effective storage access."""
from .models import Document,MountPoint
from .provider_grants import PROVIDERS
from .storage import MountedStorage,root_mount


def required_providers(user):
    root=root_mount()
    required={root.provider} if root.provider in PROVIDERS else set()
    for mount in MountPoint.objects.exclude(pk=root.pk).select_related('folder'):
        if mount.provider in PROVIDERS and mount.folder and mount.folder.allows(user,'read'):
            required.add(mount.provider)
    # A directly shared file can be readable inside an otherwise hidden mount.
    for doc in Document.objects.exclude(reference='').select_related('folder','owner','group'):
        if doc.allows(user,'read'):
            mount,_=MountedStorage().reference(doc.reference)
            if mount.provider in PROVIDERS: required.add(mount.provider)
    return [provider for provider in PROVIDERS if provider in required]
