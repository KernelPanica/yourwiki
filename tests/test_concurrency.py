from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import secrets
import threading
import pytest
from django.core.exceptions import PermissionDenied
from django.db import close_old_connections
from django.utils import timezone
from wiki.models import Invitation,User
from wiki.services import redeem_invitation

@pytest.mark.django_db(transaction=True)
def test_single_use_invite_is_atomic(workspace):
    token=secrets.token_urlsafe(32)
    invite=Invitation.objects.create(token_hash=Invitation.digest(token),creator=workspace['admin'],max_uses=1,expires_at=timezone.now()+timedelta(days=1))
    invite.groups.add(workspace['team'])
    barrier=threading.Barrier(2)
    def register(number):
        close_old_connections()
        user=User(username=f'concurrent{number}',display_name='Concurrent')
        user.set_password('Long-enough-password-6728')
        barrier.wait()
        try:
            redeem_invitation(token,user)
            return 'ok'
        except PermissionDenied:return 'denied'
        finally:close_old_connections()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(register,[1,2]))
    assert sorted(results)==['denied','ok']
    invite.refresh_from_db();assert invite.uses==1
    assert User.objects.filter(username__startswith='concurrent').count()==1
