from pathlib import PurePosixPath
import re
import json

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from wiki.models import Document, Folder, SiteConfiguration, Attachment, PendingDeletion, PdfAnnotationLayer
from wiki.native import unpack
from wiki.file_formats import decode
from wiki.services import EXTENSIONS, validate_content
from wiki.storage import StorageError, active_storage


class Command(BaseCommand):
    help = 'Adopt files and directories from all connected storage roots.'

    def handle(self, *args, **options):
        from wiki.cloud_trash import synchronize
        synchronize()
        from wiki.discovery import scan_lock
        with scan_lock:
            return self.scan(*args, **options)

    def scan(self, *args, **options):
        User = get_user_model()
        owner = User.objects.filter(is_superuser=True, is_active=True).first()
        group = Group.objects.first()
        if not owner or not group:
            raise CommandError('Create the administrator and a group before scanning storage.')
        folders, created = {}, 0
        adapter = active_storage()
        entries = []
        try:
            entries.extend(adapter.scan())
        except (AttributeError, StorageError) as error:
            if not entries: raise CommandError(str(error)) from error
            self.stderr.write(str(error))
        internal = set(Document.all_objects.exclude(history_reference='').values_list('history_reference', flat=True))
        internal.update(Attachment.objects.values_list('reference', flat=True))
        internal.update(PdfAnnotationLayer.objects.values_list('reference', flat=True))
        deleting = set(PendingDeletion.objects.filter(directory=False).values_list('reference', flat=True))
        from wiki.models import TrashEntry
        deleting.update(Document.all_objects.filter(trash__isnull=False).values_list('reference', flat=True))
        deleting_directories = list(TrashEntry.objects.filter(kind='folder').values_list('original_path', flat=True))
        for reference in PendingDeletion.objects.filter(directory=True).values_list('reference', flat=True):
            mount, relative = adapter.reference(reference)
            deleting_directories.append('/'.join(p for p in (mount.path.strip('/'), relative) if p))
        for key, reference in entries:
            if reference in internal or reference in deleting or any(key == prefix or key.startswith(prefix + '/') for prefix in deleting_directories):
                continue
            path = PurePosixPath(key)
            if not path.parts or any(part in ('.attachments', '.git') or part.startswith('.yourwiki-') for part in path.parts) or path.name.endswith(('.md.json', '.ods.json', '.docx.json', '.pdf.json')):
                continue
            if re.search(r' \(revision-\d+\)(?:\..*)?$|\.yourwiki-tmp-|\.tmp-[0-9a-f]{16}$', path.name):
                continue
            folder = None
            folder_path = []
            hidden = False
            for part in (path.parts if reference is None else path.parts[:-1]):
                folder_path.append(part)
                folder_key = str(PurePosixPath(*folder_path))
                if folder_key not in folders:
                    folder = folders[folder_key] = Folder.all_objects.get_or_create(
                        parent=folder, name=part, defaults={'owner': owner, 'group': folder.group if folder else group})[0]
                else:
                    folder = folders[folder_key]
                if folder.trash_id or Folder.all_objects.filter(pk=folder.pk, trash__isnull=False).exists():
                    hidden = True
                    break
            if hidden or reference is None:
                continue
            if Document.all_objects.filter(reference=reference).exists() or Attachment.objects.filter(reference=reference).exists() or PendingDeletion.objects.filter(reference=reference).exists():
                continue
            native_file = path.name.lower().endswith('.wiki.json')
            suffix = path.suffix.lower()
            kind = next((candidate for candidate, extension in EXTENSIONS.items() if extension == suffix.lstrip('.')), 'file')
            try:
                file_format = adapter.file_format(reference, key)
            except StorageError:
                continue
            if file_format: kind = 'table' if file_format == 'ods' else 'document'
            title = path.name if kind == 'file' else path.stem
            if native_file:
                kind, title = 'document', path.name[:-10]
            content = None
            try:
                content = adapter.read(reference)
                if suffix == '.json':
                    try:
                        if json.loads(content).get('format') == 'yourwiki-history': continue
                    except (ValueError, AttributeError): pass
                if kind != 'file':
                    text = decode(Document(file_format=file_format), content)
                    native = unpack(text)
                    if native:
                        kind = native.get('kind', kind)
                    validate_content(kind, text, SiteConfiguration.current().document_limit_mb)
            except Exception:
                # Keep objects visible even when their format has no native reader.
                kind, title, file_format = 'file', path.name, ''
            with transaction.atomic():
                if folder and Folder.all_objects.filter(pk=folder.pk, trash__isnull=False).exists(): continue
                if Document.all_objects.filter(reference=reference).exists(): continue
                Document.objects.create(title=title[:200], kind=kind, collection='Imported', owner=owner,
                                        group=folder.group if folder else group, folder=folder, reference=reference, file_format=file_format, storage_digest=adapter.fingerprint(reference, content) if content is not None else '',
                                        policy=SiteConfiguration.current().default_document_policy,
                                        inherit_permissions=True, path_synced=True)
            created += 1
        self.stdout.write(f'Storage scan adopted {created} file(s).')
