"""Discover provider objects independently of editor autosave maintenance."""
import asyncio
import io
import logging
import threading
from asgiref.sync import sync_to_async
from django.db import close_old_connections

INTERVAL = 60
scan_lock = threading.RLock()
log = logging.getLogger(__name__)


def scan_sources():
    from django.core.management import call_command
    close_old_connections()
    try:
        call_command('scan_storage', stdout=io.StringIO(), stderr=io.StringIO())
    finally:
        close_old_connections()


async def discover_sources():
    while True:
        try:
            await sync_to_async(scan_sources, thread_sensitive=False)()
        except Exception:
            log.warning('Provider discovery deferred; it will retry automatically.')
        await asyncio.sleep(INTERVAL)
