import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('wiki', '0019_write_attempt')]
    operations = [migrations.CreateModel(
        name='PdfAnnotationLayer',
        fields=[
            ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
            ('base_digest', models.CharField(max_length=255)),
            ('reference', models.TextField()),
            ('content_digest', models.CharField(max_length=64)),
            ('revision', models.PositiveIntegerField()),
            ('updated_at', models.DateTimeField(auto_now=True)),
            ('document', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='pdf_layer', to='wiki.document')),
        ],
    )]
