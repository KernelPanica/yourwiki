from unittest.mock import Mock
import pytest
from wiki.storage import GoogleDrive, OneDrive, GitHub, StorageError
from wiki import provider_sharing as sharing

class Response:
    def __init__(self,data,status=200):self.data=data;self.status_code=status;self.headers={}
    def json(self):return self.data

@pytest.mark.parametrize('role,external',[('read','reader'),('write','writer')])
def test_google_personal_create_update_revoke(role,external):
    adapter=GoogleDrive({});adapter.headers=lambda:{};adapter.private_info=Mock()
    adapter.request=Mock(side_effect=[Response({'permissions':[]}),Response({'id':'p'})])
    assert adapter.set_grant('file','user@example.org',role)=='p'
    call=adapter.request.call_args
    assert call.args[0]=='POST' and call.kwargs['json']=={'type':'user','emailAddress':'user@example.org','role':external}
    assert call.kwargs['params']['sendNotificationEmail']=='false'
    adapter.request=Mock(side_effect=[Response({'permissions':[{'id':'p','type':'user','emailAddress':'user@example.org','role':'writer'}]}),Response({})])
    assert adapter.set_grant('file','user@example.org','read','p')=='p'
    assert adapter.request.call_args.args[0]=='PATCH'
    assert adapter.request.call_args.kwargs['json']=={'role':'reader'}
    adapter.request=Mock(side_effect=[Response({'permissions':[{'id':'p','type':'user','emailAddress':'user@example.org','role':'reader'}]}),Response({})])
    adapter.revoke_grant('file','user@example.org','')
    assert adapter.request.call_args.args==('DELETE',adapter.base+'/file/permissions/p')

def test_onedrive_invite_requires_signin_and_revoke():
    adapter=OneDrive({});adapter.headers=lambda:{};adapter.private_info=Mock()
    adapter.request=Mock(side_effect=[Response({'value':[]}),Response({'value':[{'id':'p'}]})])
    assert adapter.set_grant('file','user@example.org','read')=='p'
    assert adapter.request.call_args.kwargs['json']=={'recipients':[{'email':'user@example.org'}],'roles':['read'],'requireSignIn':True,'sendInvitation':False}
    adapter.request=Mock(side_effect=[Response({'value':[{'id':'p','roles':['read'],'invitation':{'email':'user@example.org'}}]}),Response({})])
    adapter.revoke_grant('file','user@example.org','')
    assert adapter.request.call_args.args[0]=='DELETE'

def test_google_public_and_untracked_permissions_stay_blocked(monkeypatch):
    adapter=GoogleDrive({});adapter.headers=lambda:{}
    monkeypatch.setattr(sharing,'managed',lambda *a:[Mock(recipient='member@example.org')])
    for permission in ({'role':'reader','type':'anyone'},{'role':'reader','type':'user','emailAddress':'outsider@example.org'}):
        adapter.request=Mock(return_value=Response({'permissions':[permission]}))
        assert not sharing.google_managed(adapter,'file')
    adapter.request=Mock(return_value=Response({'permissions':[{'role':'reader','type':'user','emailAddress':'member@example.org'}]}))
    assert sharing.google_managed(adapter,'file')

def test_github_does_not_upgrade_read_to_write():
    adapter=GitHub({'repository':'owner/repo','token':'token'});adapter.private_repository=Mock()
    owner=Response({'owner':{'login':'owner','type':'User'}})
    adapter.request=Mock(side_effect=[owner,owner,Response([]),Response({},204)])
    with pytest.raises(StorageError,match='read-only'):
        adapter.set_grant('file','member','read')
    assert all(call.args[0]!='PUT' for call in adapter.request.call_args_list)

def test_github_write_and_invitation_revocation():
    adapter=GitHub({'repository':'owner/repo','token':'token'});adapter.private_repository=Mock()
    owner=Response({'owner':{'login':'owner','type':'User'}})
    adapter.request=Mock(side_effect=[owner,Response({'id':123},201)])
    assert adapter.set_grant('file','member','write')=='invitation:123'
    assert adapter.request.call_args.kwargs['json']=={'permission':'push'}
    adapter.request=Mock(side_effect=[owner,Response([{'id':123,'invitee':{'login':'member'}}]),Response({}),Response({})])
    adapter.revoke_grant('file','member','invitation:123')
    deletes=[call.args[1] for call in adapter.request.call_args_list if call.args[0]=='DELETE']
    assert deletes==['https://api.github.com/repos/owner/repo/invitations/123','https://api.github.com/repos/owner/repo/collaborators/member']

def test_onedrive_recovers_lost_invite_among_other_named_users():
    adapter=OneDrive({});adapter.headers=lambda:{}
    adapter.request=Mock(side_effect=[Response({'value':[
        {'id':'other','roles':['read'],'invitation':{'email':'other@example.org'}},
        {'id':'target','roles':['read'],'invitation':{'email':'target@example.org'}}]}),Response({})])
    adapter.revoke_grant('file','target@example.org','')
    assert adapter.request.call_args.args==('DELETE',adapter.base+'/items/file/permissions/target')
