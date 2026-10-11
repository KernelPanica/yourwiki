"""Official provider APIs for named, authenticated recipients only."""
from urllib.parse import quote
from .storage import StorageError


class GrantUnavailable(StorageError):
    """A credential-free explanation safe to show in the grant status."""


def managed(adapter, reference):
    mount_id = getattr(adapter, '_mount_id', None)
    if not mount_id:
        return []
    from .models import MountPoint, ProviderGrant
    from .provider_grants import target
    mount = MountPoint.objects.get(pk=mount_id)
    return list(ProviderGrant.objects.filter(provider=mount.provider,object_key=target(mount,reference)).exclude(recipient=''))


def google_permissions(adapter, ref):
    result=adapter.request('GET',adapter.base+'/'+quote(ref,safe='')+'/permissions',headers=adapter.headers(),
        params={'fields':'permissions(id,type,emailAddress,role,permissionDetails),nextPageToken','pageSize':100}).json()
    if result.get('nextPageToken') or not isinstance(result.get('permissions'),list):
        raise StorageError('Could not verify all Google sharing permissions.')
    return result['permissions']


def google_managed(adapter, ref):
    grants=managed(adapter,ref)
    if not grants:return False
    for p in google_permissions(adapter,ref):
        if p.get('role')=='owner':continue
        if p.get('type')!='user' or not any(p.get('emailAddress','').casefold()==g.recipient.casefold() for g in grants):
            return False
    return True


def google_set(adapter, ref, recipient, role, permission_id=''):
    if role not in ('read', 'write'):
        raise GrantUnavailable('Unsupported Google permission role.')
    adapter.private_info(ref)
    base=adapter.base+'/'+quote(ref,safe='')+'/permissions'
    matches=[p for p in google_permissions(adapter,ref) if p.get('type')=='user' and p.get('emailAddress','').casefold()==recipient.casefold()]
    if any(p.get('role')=='owner' for p in matches):return 'owner'
    if any(detail.get('inherited') for p in matches for detail in p.get('permissionDetails', [])):
        raise GrantUnavailable('Google access is inherited from a parent. Remove parent sharing before synchronizing per-file access.')
    body={'role':'writer' if role=='write' else 'reader'}
    if matches:
        pid=matches[0]['id']
        adapter.request('PATCH',base+'/'+quote(pid,safe=''),headers=adapter.headers(),json=body)
        return pid
    response=adapter.request('POST',base,headers=adapter.headers(),json={**body,'type':'user','emailAddress':recipient},params={'sendNotificationEmail':'false','fields':'id'}).json()
    return response['id']


def google_revoke(adapter, ref, recipient, permission_id=''):
    base=adapter.base+'/'+quote(ref,safe='')+'/permissions'
    # Rediscover by recipient to recover an ambiguous failed create response.
    try:
        permissions=google_permissions(adapter,ref)
    except StorageError:
        result=adapter.request('GET',adapter.base+'/'+quote(ref,safe=''),headers=adapter.headers(),allowed_status=(404,410))
        if result.status_code in (404,410):return
        raise
    for p in permissions:
        if p.get('role')!='owner' and p.get('type')=='user' and p.get('emailAddress','').casefold()==recipient.casefold():
            if any(detail.get('inherited') for detail in p.get('permissionDetails', [])):
                raise GrantUnavailable('Google access is inherited from a parent. Remove parent sharing before revoking per-file access.')
            adapter.request('DELETE',base+'/'+quote(p['id'],safe=''),headers=adapter.headers(),allowed_status=(404,410))


def onedrive_permissions(adapter, ref):
    response=adapter.request('GET',adapter.base+'/items/'+quote(ref,safe='')+'/permissions',headers=adapter.headers(),allowed_status=(404,410))
    if response.status_code in (404,410):return []
    result=response.json()
    if result.get('@odata.nextLink') or not isinstance(result.get('value'),list):
        raise StorageError('Could not verify all OneDrive permissions.')
    return result['value']


def ms_recipient(permission, recipient):
    principals=permission.get('grantedToIdentitiesV2',permission.get('grantedToIdentities',[]))
    single=permission.get('grantedToV2',permission.get('grantedTo'))
    if single:principals=[*principals,single]
    emails=[p.get('user',{}).get('email','') for p in principals]
    emails.append(permission.get('invitation',{}).get('email',''))
    return recipient.casefold() in [s.casefold() for s in emails if s]


def onedrive_managed(adapter, ref, permission):
    if permission.get('link') or permission.get('inheritedFrom'):return False
    return any(ms_recipient(permission,g.recipient) or (g.permission_id and permission.get('id')==g.permission_id) for g in managed(adapter,ref))


def onedrive_set(adapter, ref, recipient, role, permission_id=''):
    adapter.private_info(ref)
    base=adapter.base+'/items/'+quote(ref,safe='')
    matches=[p for p in onedrive_permissions(adapter,ref) if ms_recipient(p,recipient) or (permission_id and p.get('id')==permission_id)]
    if any('owner' in p.get('roles',[]) for p in matches):return 'owner'
    body={'roles':['write' if role=='write' else 'read']}
    if matches:
        pid=matches[0]['id']
        adapter.request('PATCH',base+'/permissions/'+quote(pid,safe=''),headers=adapter.headers(),json=body)
        return pid
    result=adapter.request('POST',base+'/invite',headers=adapter.headers(),json={**body,'recipients':[{'email':recipient}],'requireSignIn':True,'sendInvitation':False}).json()
    values=result.get('value',[])
    if len(values)!=1 or not values[0].get('id') or values[0].get('link'):
        raise StorageError('OneDrive did not confirm a personal permission.')
    return values[0]['id']


def onedrive_revoke(adapter, ref, recipient, permission_id=''):
    base=adapter.base+'/items/'+quote(ref,safe='')+'/permissions/'
    permissions=onedrive_permissions(adapter,ref)
    matches=[p for p in permissions if 'owner' not in p.get('roles',[]) and
             (ms_recipient(p,recipient) or (permission_id and p.get('id')==permission_id))]
    for p in matches:
        adapter.request('DELETE',base+quote(p['id'],safe=''),headers=adapter.headers(),allowed_status=(404,410))
    if matches or permission_id:
        return
    # A lost invite response can be recovered by email. Known other recipients
    # must not prevent revocation; only opaque principals leave it ambiguous.
    for p in permissions:
        if p.get('link') or 'owner' in p.get('roles',[]):
            continue
        principals=p.get('grantedToIdentitiesV2',p.get('grantedToIdentities',[]))
        single=p.get('grantedToV2',p.get('grantedTo'))
        if single:principals=[*principals,single]
        emails=[principal.get('user',{}).get('email') for principal in principals]
        if not p.get('invitation',{}).get('email') and not (emails and all(emails)):
            raise StorageError('Cannot identify the recipient of an incomplete OneDrive grant.')


def github_base(adapter):
    return 'https://api.github.com/repos/'+'/'.join(quote(p,safe='') for p in adapter.config['repository'].split('/'))


def github_managed(adapter, login):
    return any(g.recipient.casefold()==login.casefold() for g in managed(adapter,''))


def github_set(adapter, ref, recipient, role, permission_id=''):
    adapter.private_repository()
    base=github_base(adapter)
    info=adapter.request('GET',base,headers=adapter.headers()).json()
    if info.get('owner',{}).get('login','').casefold()==recipient.casefold():return 'owner'
    # Personal private repositories support collaborators with write access only.
    # Never silently turn a read-only local permission into repository write.
    if role=='read' and info.get('owner',{}).get('type')=='User':
        github_revoke(adapter,ref,recipient,permission_id)
        raise GrantUnavailable('GitHub personal repositories cannot grant read-only collaborator access. Use Yourwiki to read this file.')
    result=adapter.request('PUT',base+'/collaborators/'+quote(recipient,safe=''),headers=adapter.headers(),json={'permission':'push' if role=='write' else 'pull'})
    if result.status_code==201:
        return 'invitation:'+str(result.json()['id'])
    return 'collaborator:'+recipient


def github_revoke(adapter, ref, recipient, permission_id=''):
    base=github_base(adapter)
    info=adapter.request('GET',base,headers=adapter.headers()).json()
    if info.get('owner',{}).get('login','').casefold()==recipient.casefold():return
    response=adapter.request('GET',base+'/invitations',headers=adapter.headers(),params={'per_page':100})
    if response.headers.get('Link'):
        raise StorageError('Too many repository invitations to verify revocation.')
    for invite in response.json():
        if invite.get('invitee',{}).get('login','').casefold()==recipient.casefold():
            adapter.request('DELETE',base+'/invitations/'+str(invite['id']),headers=adapter.headers(),allowed_status=(404,))
    adapter.request('DELETE',base+'/collaborators/'+quote(recipient,safe=''),headers=adapter.headers(),allowed_status=(404,))
