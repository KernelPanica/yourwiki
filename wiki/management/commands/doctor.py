from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection

from wiki.models import PendingDeletion, User, Workspace, Collaboration, MountPoint
from django.db.models import F
from wiki.storage import StorageError, active_storage


class Command(BaseCommand):
    help = "Run redacted database, volume, setup, and optional storage diagnostics."

    def add_arguments(self, parser):
        parser.add_argument(
            "--storage",
            action="store_true",
            help="Create, read, update, and delete a unique provider probe file.",
        )

    def handle(self, *args, **options):
        failures = []
        with connection.cursor() as cursor:
            cursor.execute("PRAGMA integrity_check")
            integrity = cursor.fetchone()[0]
        self.stdout.write(f"SQLite integrity: {integrity}")
        if integrity != "ok":
            failures.append("SQLite integrity check failed")

        for label, path in (
            ("database", Path(settings.DATA_DIR)),
            ("secrets", Path(settings.SECRETS_DIR)),
            ("local documents", Path(settings.DOCUMENTS_DIR)),
        ):
            exists = path.exists() and path.is_dir()
            self.stdout.write(f"{label.capitalize()} directory: {'present' if exists else 'missing'}")
            if not exists:
                failures.append(f"{label} directory is missing")

        workspace = Workspace.objects.filter(pk=1).first()
        self.stdout.write(f"Initialized: {bool(workspace and workspace.initialized)}")
        self.stdout.write(f"Storage provider: {workspace.provider if workspace else 'not configured'}")
        for mount in MountPoint.objects.all():
            self.stdout.write(f"Mount: {mount.path} ({mount.provider})")
        self.stdout.write(f"Active users: {User.objects.filter(is_active=True).count()}")
        self.stdout.write(f"Pending storage deletions: {PendingDeletion.objects.count()}")
        self.stdout.write(f"Pending collaboration snapshots: {Collaboration.objects.exclude(sequence=F('synced_sequence')).count()}")
        if not workspace or not workspace.initialized:
            failures.append("workspace is not initialized")

        if options["storage"] and not failures:
            try:
                active_storage().probe()
            except StorageError:
                failures.append("storage create/read/update/delete probe failed")
                self.stdout.write("Storage probe: failed (details intentionally redacted)")
            else:
                self.stdout.write("Storage probe: passed")

        if failures:
            raise CommandError("; ".join(failures))
        self.stdout.write(self.style.SUCCESS("Yourwiki diagnostics passed."))
