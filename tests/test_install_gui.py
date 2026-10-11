"""Exercise the browser installer through its real HTTP and database boundary."""
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def test_browser_installer_private_setup_and_completion(tmp_path):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {**os.environ, 'YOURWIKI_DATA': str(tmp_path/'data'), 'YOURWIKI_SECRETS': str(tmp_path/'secrets'), 'BROWSER': 'true'}
    output = tmp_path/'installer.log'
    with output.open('w') as log:
        process = subprocess.Popen([sys.executable, 'install.py', '--allow-http', '--port', str(port)], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                content = output.read_text()
                match = re.search(r'#token=([^\s]+)', content)
                if match:
                    break
                assert process.poll() is None, content
                time.sleep(.1)
            assert match
            token = match.group(1)
            origin = f'http://127.0.0.1:{port}'
            def call(path, body=None, authenticated=True):
                headers = {'Content-Type': 'application/json'}
                if authenticated:
                    headers['X-Setup-Token'] = token
                request = urllib.request.Request(origin+path, data=json.dumps(body).encode() if body else None, headers=headers)
                try:
                    response = urllib.request.urlopen(request, timeout=10)
                except urllib.error.HTTPError as exc:
                    response = exc
                with response:
                    return response.status, response.read()
            assert call('/setup/')[0] == 200
            assert token.encode() not in call('/setup/')[1]
            assert call('/setup/status', authenticated=False)[0] == 403
            assert call('/setup/oauth/callback?state=wrong&code=secret')[0] == 400
            config = {'public_url': origin, 'admin': {'username': 'owner', 'display_name': 'Owner', 'password': 'Very-long-password-3927'}, 'storage': {'provider': 'local', 'root': str(tmp_path/'documents')}}
            assert call('/setup/install', config, authenticated=False)[0] == 403
            assert call('/setup/install', {'public_url': origin})[0] == 400
            assert call('/setup/install', config)[0] == 202
            for _ in range(100):
                code, body = call('/setup/status')
                state = json.loads(body)
                if state['phase'] in ('complete', 'error'):
                    break
                time.sleep(.1)
            assert state['phase'] == 'complete', state
            assert config['admin']['password'] not in output.read_text()+body.decode()
            assert call('/setup/install', config)[0] == 409
            with sqlite3.connect(tmp_path/'data/wiki.sqlite3') as db:
                assert db.execute('select username,is_superuser from wiki_user').fetchall() == [('owner', 1)]
        finally:
            process.terminate()
            process.wait(timeout=10)


def test_browser_installer_layout_and_success(tmp_path):
    import pytest
    if os.environ.get('RUN_BROWSER') != '1':
        pytest.skip('Set RUN_BROWSER=1')
    from playwright.sync_api import sync_playwright, expect
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {**os.environ, 'YOURWIKI_DATA': str(tmp_path/'data'), 'YOURWIKI_SECRETS': str(tmp_path/'secrets'), 'BROWSER': 'true'}
    log_path = tmp_path/'browser-installer.log'
    with log_path.open('w') as log:
        process = subprocess.Popen([sys.executable, 'install.py', '--allow-http', '--port', str(port)], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                match = re.search(r'http://[^\s]+#token=[^\s]+', log_path.read_text())
                if match:
                    break
                time.sleep(.1)
            assert match
            with sync_playwright() as p:
                browser = p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'))
                page = browser.new_page(viewport={'width': 390, 'height': 844})
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(match.group())
                assert '#token=' not in page.url
                page.locator('[name=public_url]').fill(f'http://127.0.0.1:{port}')
                page.locator('[name=username]').fill('owner')
                page.locator('[name=password]').fill('Very-long-password-3927')
                page.locator('[name=confirm]').fill('Very-long-password-3927')
                page.locator('#provider').select_option('google')
                expect(page.locator('#redirect')).to_have_text(f'http://127.0.0.1:{port}/setup/oauth/callback')
                page.locator('#provider').select_option('local')
                page.locator('[name=storage_root]').fill(str(tmp_path/'documents'))
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                page.get_by_role('button', name='Установить Yourwiki').click()
                expect(page.locator('#status')).to_have_attribute('data-phase', 'complete', timeout=30000)
                expect(page.locator('#login')).to_be_visible()
                assert not errors
                page.screenshot(path='/tmp/yourwiki-installer-mobile.png', full_page=True)
                browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
