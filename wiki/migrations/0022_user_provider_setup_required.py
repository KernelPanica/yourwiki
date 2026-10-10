from django.db import migrations,models


class Migration(migrations.Migration):
    dependencies=[('wiki','0021_presence')]
    operations=[migrations.AddField(model_name='user',name='provider_setup_required',field=models.BooleanField(default=False))]
