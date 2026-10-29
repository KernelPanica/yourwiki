from django.db import migrations, models

class Migration(migrations.Migration):
    dependencies = [('wiki', '0031_personal_access_rules')]
    operations = [migrations.CreateModel(name='OfficeFontActivation', fields=[
        ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
        ('name', models.CharField(max_length=200, unique=True)),
        ('created_at', models.DateTimeField(auto_now_add=True)),
    ])]
