from django.apps import AppConfig
from django.db.backends.signals import connection_created

def sqlite_settings(sender, connection, **kwargs):
    if connection.vendor == 'sqlite':
        with connection.cursor() as cursor:
            cursor.execute('PRAGMA journal_mode=WAL')
            cursor.execute('PRAGMA foreign_keys=ON')

class WikiConfig(AppConfig):
    name = 'wiki'
    def ready(self):
        connection_created.connect(sqlite_settings, dispatch_uid='wiki.sqlite')
