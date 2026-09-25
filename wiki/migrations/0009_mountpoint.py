from django.db import migrations, models
import django.db.models.deletion


def root_mount(apps, schema_editor):
    workspace = apps.get_model('wiki', 'Workspace').objects.filter(pk=1, initialized=True).first()
    if workspace:
        apps.get_model('wiki', 'MountPoint').objects.create(
            path='/', provider=workspace.provider, encrypted_config=workspace.encrypted_config)


class Migration(migrations.Migration):
    dependencies = [('wiki', '0008_document_path_synced')]
    operations = [
        migrations.CreateModel(name='MountPoint', fields=[
            ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
            ('path', models.CharField(max_length=2048, unique=True)),
            ('provider', models.CharField(max_length=20)),
            ('encrypted_config', models.TextField()),
            ('folder', models.OneToOneField(null=True, blank=True, on_delete=django.db.models.deletion.PROTECT, related_name='mountpoint', to='wiki.folder')),
        ], options={'ordering': ['path']}),
        migrations.RunPython(root_mount, migrations.RunPython.noop),
    ]
