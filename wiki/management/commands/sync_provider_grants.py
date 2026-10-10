from django.core.management.base import BaseCommand
from wiki.provider_grants import sync_provider_grants
from wiki.models import ProviderGrant

class Command(BaseCommand):
    help = 'Reconcile and retry personal provider grants from current effective permissions.'

    def handle(self, **options):
        sync_provider_grants(force=True)
        self.stdout.write(f"Pending: {ProviderGrant.objects.filter(status='pending').count()}; failed: {ProviderGrant.objects.filter(status='failed').count()}")
