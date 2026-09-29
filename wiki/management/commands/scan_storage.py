from pathlib import PurePosixPath
import re

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from wiki.models import Document, Folder, SiteConfiguration
from wiki.native import unpack
from wiki.services import EXTENSIONS, validate_content
from wiki.storage import StorageError, active_storage


class Command(BaseCommand):
    help = 'Adopt supported files found below the root storage directory.'

    def handle(self, *args, **options):
        User = get_user_model()
        owner = User.objects.filter(is_superuser=True, is_active=True).first()
        group = Group.objects.first()
        if not owner or not group:
            raise CommandError('Create the administrator and a group before scanning storage.')
        folders, created = {}, 0
        adapter = active_storage()
        try:
            entries = list(adapter.scan())
        except (AttributeError, StorageError) as error:
            raise CommandError(str(error)) from error
        for key, reference in entries:
            path = PurePosixPath(key)
            if not path.parts or path.name.startswith('.'):
                continue
            if re.search(r' \(revision-\d+\)(?:\.[^.]+)?$', path.name):
                continue
            folder = None
            folder_path = []
            for part in path.parts[:-1]:
                folder_path.append(part)
                folder_key = str(PurePosixPath(*folder_path))
                if folder_key not in folders:
                    folder = folders[folder_key] = Folder.objects.get_or_create(
                        parent=folder, name=part, defaults={'owner': owner, 'group': group})[0]
                else:
                    folder = folders[folder_key]
            if Document.objects.filter(reference=reference).exists():
                continue
            native_file = path.name.lower().endswith('.wiki.json')
            suffix = path.suffix.lower()
            kind = next((candidate for candidate, extension in EXTENSIONS.items() if extension == suffix.lstrip('.')), 'file')
            title = path.name if kind == 'file' else path.stem
            if native_file:
                kind, title = 'document', path.name[:-10]
            try:
                content = adapter.read(reference)
                if kind != 'file':
                    text = content.decode('utf-8')
                    native = unpack(text)
                    if native:
                        kind = native.get('kind', kind)
                    validate_content(kind, text, SiteConfiguration.current().document_limit_mb)
            except Exception:
                continue
            with transaction.atomic():
                Document.objects.create(title=title[:200], kind=kind, collection='Imported', owner=owner,
                                        group=group, folder=folder, reference=reference,
                                        policy=SiteConfiguration.current().default_document_policy,
                                        inherit_permissions=bool(folder), path_synced=True)
            created += 1
        self.stdout.write(f'Storage scan adopted {created} file(s).')
