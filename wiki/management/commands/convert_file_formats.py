"""Convert legacy editor snapshots without discarding their native metadata."""
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from wiki.models import Document
from wiki.collaboration import current_content
from wiki.file_history import persist
from wiki.services import storage_key
from wiki.source import check_available


class Command(BaseCommand):
    help = 'Convert legacy text/table files to embedded Markdown/ODS; stop editors and back up first.'

    def handle(self, *args, **options):
        count = 0
        from wiki.realtime import connections
        for pk in Document.objects.filter(file_format='', kind__in=['document', 'table']).values_list('pk', flat=True):
            try:
                with transaction.atomic():
                    doc = Document.objects.get(pk=pk)
                    check_available(doc)
                    if connections.get(str(pk)):
                        raise ValueError('Close active editors first.')
                    content = current_content(doc)
                    doc.file_format = 'md' if doc.kind == 'document' else 'ods'
                    doc.reference = persist(doc, content, storage_key(doc))
                    doc.path_synced = True
                    doc.revision += 1
                    doc.save()
                    count += 1
            except Exception as error:
                raise CommandError(f'Conversion paused after {count} files; document {pk}: {error}') from error
        self.stdout.write(f'Converted {count} files. Existing ACLs and editor metadata were retained.')
