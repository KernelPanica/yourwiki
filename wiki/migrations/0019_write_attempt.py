import django.db.models.deletion
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('wiki', '0018_collaboration_structure')]
    operations = [migrations.AlterField(model_name='savesession', name='state', field=models.CharField(max_length=12, default='pending', choices=[(s,s) for s in ('pending','saved','failed','conflict','denied','unknown')])), migrations.CreateModel(name='WriteAttempt', fields=[
        ('id', models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False, serialize=False)),
        ('state', models.CharField(max_length=16, default='unknown')),
        ('expected_fingerprint', models.CharField(max_length=64, blank=True)),
        ('intended_digest', models.CharField(max_length=64)),
        ('confirmed_fingerprint', models.CharField(max_length=64, blank=True)),
        ('reference', models.TextField(blank=True)),
        ('created_at', models.DateTimeField(auto_now_add=True)),
        ('document', models.ForeignKey(to='wiki.document', on_delete=django.db.models.deletion.CASCADE, related_name='write_attempts')),
    ])]
