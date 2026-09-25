import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings')
import django
django.setup()
from django.core.management import call_command
from django.core.management.base import CommandError
from wiki.models import Workspace
call_command('migrate',interactive=False,verbosity=0)
if not Workspace.objects.filter(pk=1,initialized=True).exists():
    raise SystemExit('Run docker compose run --rm --service-ports setup first.')
try:
    call_command('sync_storage_tree', verbosity=0)
except CommandError as error:
    print(f'{error} The web server will start; retry with python manage.py sync_storage_tree.', flush=True)
os.execvp('uvicorn',['uvicorn','config.asgi:application','--host','0.0.0.0','--port','8000','--workers','1','--ws-max-size','9437184','--no-access-log'])
