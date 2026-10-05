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


@pytest.mark.django_db(transaction=True)
def test_two_file_saves_cannot_overwrite_each_other(workspace, document):
    from wiki.models import Document
    from wiki.services import Conflict, save_document
    from wiki.storage import active_storage
    barrier = threading.Barrier(2)
    def save(number):
        close_old_connections()
        stale = Document.objects.get(pk=document.pk)
        barrier.wait()
        try:
            save_document(workspace['admin'], stale.title, stale.kind, stale.collection,
                          f'Client {number}', workspace['team'], stale, stale.revision)
            return ('saved', number)
        except Conflict:
            return ('conflict', number)
        finally:
            close_old_connections()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, [1, 2]))
    assert sorted(status for status, _ in results) == ['conflict', 'saved']
    winner = next(number for status, number in results if status == 'saved')
    document.refresh_from_db()
    assert document.revision == 2
    assert active_storage().read(document.reference) == f'Client {winner}'.encode()
