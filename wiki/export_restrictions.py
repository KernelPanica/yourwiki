"""Reconcile managed Google originals; leave unmanaged restrictions untouched."""
from urllib.parse import quote
from django.utils import timezone
from .models import Document, ProviderExportRestriction
from .storage import MountedStorage, mount_adapter, StorageError


def sync(force=False):
    desired={}
    for document in Document.objects.exclude(reference='').select_related('folder'):
        mount,reference=MountedStorage().reference(document.reference)
        if mount.provider=='google':
            key=(mount.pk,reference)
            previous=desired.get(key)
            desired[key]=(mount,reference,document.export_restricted() or bool(previous and previous[2]))
    states={(s.mount_id,s.reference):s for s in ProviderExportRestriction.objects.select_related('mount')}
    for key,(mount,reference,restricted) in desired.items():
        state=states.get(key)
        if not restricted and not state:continue
        if state is None:state=ProviderExportRestriction.objects.create(mount=mount,reference=reference)
        if state.applied==restricted and not state.error and not force:continue
        try:
            adapter=mount_adapter(mount)
            url=adapter.base+'/'+quote(reference,safe='')
            # Do not overwrite an existing restriction that Yourwiki did not apply.
            info=adapter.request('GET',url,headers=adapter.headers(),params={'fields':'capabilities(canChangeItemDownloadRestriction),downloadRestrictions'}).json()
            if info.get('capabilities',{}).get('canChangeItemDownloadRestriction') is not True:
                raise StorageError('The connected account cannot change download restrictions.')
            if state.original is None:
                state.original=info.get('downloadRestrictions',{}).get('itemDownloadRestriction',{})
                state.save(update_fields=['original'])
            expected={'restrictedForReaders':True,'restrictedForWriters':True} if restricted else {name:bool(state.original.get(name)) for name in ('restrictedForReaders','restrictedForWriters')}
            adapter.request('PATCH',url,headers=adapter.headers(),json={'downloadRestrictions':{'itemDownloadRestriction':expected}},params={'fields':'downloadRestrictions'})
            checked=adapter.request('GET',url,headers=adapter.headers(),params={'fields':'downloadRestrictions'}).json()
            actual=checked.get('downloadRestrictions',{}).get('itemDownloadRestriction',{})
            if any(bool(actual.get(name))!=expected[name] for name in ('restrictedForReaders','restrictedForWriters')):
                raise StorageError('The provider did not confirm the requested restriction.')
            state.applied=restricted;state.error=''
        except Exception:
            state.error='Google Drive export restriction was not confirmed. Local restriction remains active; synchronization will retry.'
        state.checked_at=timezone.now();state.save(update_fields=['applied','error','checked_at'])
