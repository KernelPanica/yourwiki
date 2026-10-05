from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('wiki', '0013_document_file_format_document_history_reference_and_more')]
    operations = [migrations.AddField(
        model_name='document', name='group_policies', field=models.JSONField(default=dict),
    )]
