import hashlib
import secrets
from datetime import timedelta
from django.db import transaction
from django.utils import timezone
from .models import SourceLease
from .services import Conflict


def valid(document, user, token):
    return bool(token) and SourceLease.objects.filter(document=document,owner=user,token_hash=hashlib.sha256(token.encode()).hexdigest(),expires_at__gt=timezone.now()).exists()


def acquire(document, user, token=None):
    from .realtime import connections
    with transaction.atomic():
        if valid(document,user,token):
            return token
        if connections.get(str(document.pk)) or SourceLease.objects.filter(document=document,expires_at__gt=timezone.now()).exists():
            raise Conflict('Close active visual editors or wait for the current source session to finish before editing source.')
        token=secrets.token_urlsafe(32)
        SourceLease.objects.update_or_create(document=document,defaults={'owner':user,'token_hash':hashlib.sha256(token.encode()).hexdigest(),'expires_at':timezone.now()+timedelta(minutes=15)})
        return token


def release(document,user,token):
    if valid(document,user,token):
        SourceLease.objects.filter(document=document).delete()


def check_available(document):
    if SourceLease.objects.filter(document=document,expires_at__gt=timezone.now()).exists():
        raise Conflict('An exclusive source editing session is active (up to 15 minutes). Save or cancel it before opening the visual editor.')
