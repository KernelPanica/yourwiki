"""Opt-in destructive probes only touch unique .yourwiki-probe-* files."""
import json
import os
from pathlib import Path
import pytest
from wiki.storage import ADAPTERS,SafeAdapter

@pytest.mark.live_storage
@pytest.mark.parametrize('provider',['local','google','onedrive','github','smb','sftp'])
def test_live_provider(provider):
    location=os.environ.get('YOURWIKI_STORAGE_TEST_CONFIG')
    if not location:pytest.skip('Provide a private JSON file through YOURWIKI_STORAGE_TEST_CONFIG')
    configs=json.loads(Path(location).read_text())
    if provider not in configs:pytest.skip(f'No {provider} credentials configured')
    config=configs[provider]
    adapter=SafeAdapter(ADAPTERS[provider](config))
    adapter.probe()
