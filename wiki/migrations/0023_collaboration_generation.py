import uuid
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('wiki', '0022_user_provider_setup_required')]
    operations = [migrations.AddField(model_name='collaboration', name='generation',
                                     field=models.UUIDField(default=uuid.uuid4, editable=False))]
