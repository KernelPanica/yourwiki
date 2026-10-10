"""Ephemeral editing sessions, separate from file and CRDT state."""
import uuid
from django.db import models


class PresenceSession(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey('wiki.Document', on_delete=models.CASCADE, related_name='presence_sessions')
    user = models.ForeignKey('wiki.User', on_delete=models.CASCADE, related_name='presence_sessions')
    color = models.CharField(max_length=7)
    selection = models.JSONField(default=dict)
    heartbeat = models.DateTimeField()
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        app_label = 'wiki'
