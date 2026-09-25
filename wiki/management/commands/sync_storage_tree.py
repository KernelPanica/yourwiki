"""Copy current legacy revisions into the provider's directory tree."""
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from wiki.folders import storage_path
from wiki.models import Document, Folder
from wiki.services import storage_key
from wiki.storage import StorageError, active_storage


class Command(BaseCommand):
    help = 'Synchronize existing files and empty directories with the storage provider.'

    def handle(self, *args, **options):
        adapter = active_storage()
        count = 0
        try:
            for folder in Folder.objects.select_related('parent'):
                adapter.ensure_dir(storage_path(folder))
            for doc in Document.objects.filter(path_synced=False).select_related('folder'):
                key = storage_key(doc)
                if doc.folder:
                    adapter.ensure_dir(key.rpartition('/')[0])
                reference = adapter.write(key, adapter.read(doc.reference))
                try:
                    with transaction.atomic():
                        current = Document.objects.get(pk=doc.pk)
                        if current.path_synced or current.reference != doc.reference:
                            adapter.delete(reference)
                            continue
                        current.reference = reference
                        current.path_synced = True
                        current.save(update_fields=['reference', 'path_synced'])
                except Exception:
                    adapter.delete(reference)
                    raise
                count += 1
        except StorageError as error:
            raise CommandError(f'Storage tree sync paused after {count} files: {error}') from error
        self.stdout.write(f'Storage tree synchronized: {count} existing files.')
