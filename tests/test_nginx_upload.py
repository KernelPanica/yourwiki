"""RUN_NGINX=1 NGINX_BINARY=/path/to/nginx pytest tests/test_nginx_upload.py -q"""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
import pytest
import requests

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.skipif(os.environ.get('RUN_NGINX') != '1', reason='Requires an Nginx executable and local sockets')]


@pytest.mark.parametrize("limit_mb", [1, 5, 8])
def test_production_proxy_upload_limits(workspace, client, live_server, tmp_path, settings, limit_mb):
    binary = os.environ.get('NGINX_BINARY') or shutil.which('nginx')
    assert binary, 'Set NGINX_BINARY to the nginx executable.'
    settings.ALLOWED_HOSTS += ['localhost', '127.0.0.1']
    settings.SESSION_COOKIE_SECURE = False
    from wiki.models import SiteConfiguration
    SiteConfiguration.objects.update_or_create(pk=1, defaults={'document_limit_mb': limit_mb})
    client.force_login(workspace['admin'])
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    snippet = (Path(__file__).parents[1] / 'docker/nginx-location.conf').read_text()
    snippet = snippet.replace('http://127.0.0.1:3000', live_server.url)
    config = tmp_path / 'nginx.conf'
    config.write_text(f'daemon off; master_process off; pid {tmp_path}/nginx.pid; error_log stderr warn; events {{ worker_connections 64; }} http {{ access_log off; client_body_temp_path {tmp_path}/body; proxy_temp_path {tmp_path}/proxy; fastcgi_temp_path {tmp_path}/fastcgi; uwsgi_temp_path {tmp_path}/uwsgi; scgi_temp_path {tmp_path}/scgi; server {{ listen 127.0.0.1:{port}; {snippet} }} }}')
    process = subprocess.Popen([binary, '-p', str(tmp_path), '-c', str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    session = requests.Session()
    session.cookies.update({name: cookie.value for name, cookie in client.cookies.items()})
    url = f'http://localhost:{port}'
    try:
        for _ in range(100):
            assert process.poll() is None, process.stderr.read().decode()
            try:
                if session.get(url + '/health/', timeout=1).status_code == 200: break
            except requests.ConnectionError: pass
            time.sleep(.05)
        page = session.get(url + '/files/upload/', timeout=10)
        assert page.status_code == 200
        csrf = session.cookies.get('csrftoken')
        def upload(name, data, accept='text/html'):
            return session.post(url+'/files/upload/', files={'file': (name, data)}, data={'path':'/', 'csrfmiddlewaretoken':csrf}, headers={'Origin':url, 'Accept':accept}, allow_redirects=False, timeout=30)
        settings.CSRF_TRUSTED_ORIGINS = [url]
        response = upload('within-limit.bin', b'x' * (limit_mb*1024*1024))
        assert response.status_code == 302, response.text[:500]
        from wiki.models import Document
        from wiki.storage import active_storage
        doc = Document.objects.get(title='within-limit.bin')
        assert len(active_storage().read(doc.reference)) == limit_mb*1024*1024
        response = upload('over-app-limit.bin', b'x'*(limit_mb*1024*1024+1))
        assert response.status_code == 400 and f'{limit_mb} MB' in response.text
        response = upload('over-json-limit.bin', b'x'*(limit_mb*1024*1024+1), 'application/json')
        assert response.status_code == 400
        assert f'{limit_mb} MB' in response.json()['errors']['file'][0]['message']
        assert f'{limit_mb} MB' in response.json()['error']
        assert not Document.objects.filter(title__startswith='over-').exists()
        response = upload('over-proxy-limit.bin', b'x'*(61*1024*1024))
        assert response.status_code == 400 and f'{limit_mb} MB' in response.text
        SiteConfiguration.objects.filter(pk=1).update(document_limit_mb=0)
        response = upload('unlimited.bin', b'x'*(61*1024*1024))
        assert response.status_code == 302, response.text[:500]
        doc = Document.objects.get(title='unlimited.bin')
        assert len(active_storage().read(doc.reference)) == 61*1024*1024
    finally:
        process.terminate()
        process.wait(timeout=10)
        session.close()
