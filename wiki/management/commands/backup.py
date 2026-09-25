from pathlib import Path
import sqlite3
from django.conf import settings
from django.core.management.base import BaseCommand,CommandError

class Command(BaseCommand):
    help='Create a consistent SQLite backup. Also back up document and secrets volumes.'
    def add_arguments(self,parser): parser.add_argument('destination')
    def handle(self,*args,**options):
        destination=Path(options['destination']).resolve()
        if destination.exists(): raise CommandError('Destination already exists; refusing to overwrite it.')
        source=sqlite3.connect(f'file:{settings.DATABASES["default"]["NAME"]}?mode=ro',uri=True)
        target=sqlite3.connect(destination)
        try: source.backup(target)
        finally: target.close();source.close()
        destination.chmod(0o600)
        self.stdout.write('Database backup created. Preserve the encryption key and document storage too.')
