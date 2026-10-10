from django.db import migrations


def migrate_permissions(apps, schema_editor):
    def rule(value):
        visible = value.get('visible', True) is True
        write = visible and value.get('write') is True
        return {'read':visible and (value.get('read') is True or write), 'write':write}
    def policy(value):
        return {scope:rule(value.get(scope, {})) for scope in ('owner','group','everyone')}
    db = schema_editor.connection.alias
    for name,parent in [('Document','folder_id'), ('Folder','parent_id')]:
        model = apps.get_model('wiki', name)
        for item in model.objects.using(db).all().iterator():
            item.policy = policy(item.policy)
            item.group_policies = {key:rule(value) for key,value in item.group_policies.items()}
            # Previously, a root inherited its own stored policy, not workspace defaults.
            if getattr(item,parent) is None:
                item.inherit_permissions = False
            item.save(using=db, update_fields=['policy','group_policies','inherit_permissions'])
    for site in apps.get_model('wiki','SiteConfiguration').objects.using(db).all().iterator():
        site.default_document_policy = policy(site.default_document_policy)
        site.save(using=db,update_fields=['default_document_policy'])


class Migration(migrations.Migration):
    dependencies = [('wiki', '0014_document_group_policies')]
    operations = [migrations.RunPython(migrate_permissions)]
