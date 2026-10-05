"""Move legacy files into the provider tree without retaining duplicate originals."""
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
            for pk in Document.objects.filter(path_synced=False).values_list('pk', flat=True):
                with transaction.atomic():
                    doc = Document.objects.get(pk=pk)
                    if doc.path_synced: continue
                    doc.reference = adapter.move(doc.reference, storage_key(doc))
                    doc.storage_digest = adapter.fingerprint(doc.reference, adapter.read(doc.reference))
                    doc.path_synced = True
                    doc.save(update_fields=['reference', 'path_synced', 'storage_digest'])
                    count += 1
        except StorageError as error:
            raise CommandError(f'Storage tree sync paused after {count} files: {error}') from error
        self.stdout.write(f'Storage tree synchronized: {count} existing files.')
