import uuid
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('wiki', '0020_pdf_layers')]
    operations = [migrations.CreateModel(name='PresenceSession', fields=[
        ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
        ('color', models.CharField(max_length=7)),
        ('selection', models.JSONField(default=dict)),
        ('heartbeat', models.DateTimeField()),
        ('expires_at', models.DateTimeField(db_index=True)),
        ('document', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='presence_sessions', to='wiki.document')),
        ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='presence_sessions', to='wiki.user')),
    ])]
