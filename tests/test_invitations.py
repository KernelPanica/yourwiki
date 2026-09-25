from datetime import timedelta
import secrets
import pytest
from django.contrib.auth.models import Group
from django.urls import reverse
from django.utils import timezone
from wiki.models import Invitation,User


def make_invite(creator,group,**kwargs):
    token=secrets.token_urlsafe(32)
    invite=Invitation.objects.create(creator=creator,token_hash=Invitation.digest(token),expires_at=timezone.now()+timedelta(days=7),**kwargs)
    invite.groups.add(group)
    return token,invite


def signup(username='newuser'):
    return {'username':username,'display_name':'New Member','password1':'Long-secure-pass-2785','password2':'Long-secure-pass-2785'}

@pytest.mark.django_db
class TestInvitations:
    def test_create_and_redeem_once(self,client,workspace):
        client.force_login(workspace['admin'])
        response=client.post('/invitations/',{'days':7,'max_uses':1,'groups':[workspace['team'].pk]})
        assert response.status_code==200
        link=response.context['invite_link']
        assert link and Invitation.objects.count()==1
        token=link.rstrip('/').split('/')[-1]
        invitation=Invitation.objects.get();assert invitation.token_hash!=token
        client.logout()
        path=reverse('redeem',args=[token])
        assert client.get(path).status_code==200
        assert client.post(path,signup()).status_code==302
        user=User.objects.get(username='newuser')
        assert user.groups.filter(pk=workspace['team'].pk).exists()
        assert not user.is_superuser and not user.can_invite
        client.logout()
        assert client.post(path,signup('second')).status_code==500
        invitation.refresh_from_db();assert invitation.uses==1

    def test_member_invite_delegation_and_group_restrictions(self,client,workspace):
        member=workspace['member'];member.can_invite=True;member.save()
        member.invite_groups.add(workspace['team'])
        forbidden=Group.objects.create(name='private')
        client.force_login(member)
        assert client.post('/invitations/',{'days':7,'max_uses':1,'groups':[forbidden.pk]}).status_code==400
        assert client.post('/invitations/',{'days':7,'max_uses':1,'groups':[workspace['team'].pk]}).status_code==200
        invitation=Invitation.objects.get();assert invitation.creator==member
        token,other=make_invite(workspace['admin'],workspace['team'])
        assert client.post(reverse('revoke',args=[other.pk])).status_code==500
        assert client.post(reverse('revoke',args=[invitation.pk])).status_code==302

    def test_expired_revoked_and_exhausted_are_identical(self,client,workspace):
        bodies=[]
        for state in ('expired','revoked','exhausted'):
            token,invite=make_invite(workspace['admin'],workspace['team'])
            if state=='expired': invite.expires_at=timezone.now()-timedelta(seconds=1)
            if state=='revoked': invite.revoked=True
            if state=='exhausted': invite.uses=1
            invite.save()
            response=client.get(reverse('redeem',args=[token]));assert response.status_code==500
            bodies.append(response.content)
        assert len(set(bodies))==1

    def test_removed_inviter_permission_invalidates_link(self,client,workspace):
        user=workspace['member'];user.can_invite=True;user.save();user.invite_groups.add(workspace['team'])
        token,invite=make_invite(user,workspace['team'])
        user.invite_groups.clear()
        assert client.get(reverse('redeem',args=[token])).status_code==500

    def test_reusable_link(self,client,workspace):
        token,invite=make_invite(workspace['admin'],workspace['team'],max_uses=0)
        for username in ('first','second'):
            client.logout()
            assert client.post(reverse('redeem',args=[token]),signup(username)).status_code==302
        invite.refresh_from_db();assert invite.uses==2

    def test_admin_member_controls(self,client,workspace):
        client.force_login(workspace['admin'])
        user=workspace['member']
        response=client.post(reverse('member',args=[user.pk]),{'display_name':'Updated','is_active':'on','can_invite':'on','groups':[workspace['team'].pk],'invite_groups':[workspace['team'].pk]})
        assert response.status_code==302
        user.refresh_from_db();assert user.can_invite
        assert user.invite_groups.filter(pk=workspace['team'].pk).exists()
        response=client.post(reverse('member',args=[workspace['admin'].pk]),{'display_name':'Admin'})
        assert response.status_code==400
