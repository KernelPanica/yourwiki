from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('wiki', '0009_mountpoint')]
    operations = [migrations.AddField(
        model_name='folder', name='group_policies', field=models.JSONField(default=dict),
    )]
