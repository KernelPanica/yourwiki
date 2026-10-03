"""Direct Python storage adapters. References are private, never sent to browsers."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import secrets
import stat
import threading
from urllib.parse import quote

import requests

MAX_BYTES = 5 * 1024 * 1024
HISTORY_MAX_BYTES = 50 * 1024 * 1024

class StorageError(Exception):
    pass


def safe_key(key):
    if not isinstance(key, str) or not key or '\\' in key or any(p in ('', '.', '..') for p in key.split('/')) or key.startswith('/'):
        raise StorageError('Invalid storage path.')
    return key


def bounded(data, limit=MAX_BYTES):
    if len(data) > limit:
        raise StorageError(f'File exceeds the {limit // (1024*1024)} MB limit.')
    return data

class Adapter:
    def __init__(self, config, save_config=None):
        self.config = config
        self.save_config = save_config or (lambda c: None)

    def probe(self):
        key = '.yourwiki-probe-' + secrets.token_hex(12)
        ref = None
        try:
            ref = self.write(key, b'yourwiki storage test')
            if self.read(ref) != b'yourwiki storage test':
                raise StorageError('Storage read verification failed.')
            ref = self.write(key, b'updated', ref)
            if self.read(ref) != b'updated':
                raise StorageError('Storage update verification failed.')
        finally:
            if ref is not None:
                self.delete(ref)

    def location(self, ref):
        return ref

    def original_url(self, ref):
        return ''

    def ensure_dir(self, key):
        safe_key(key)

class Local(Adapter):
    def path(self, key):
        safe_key(key)
        root = Path(self.config['root']).resolve()
        result = (root / key).resolve()
        if not result.is_relative_to(root):
            raise StorageError('Invalid storage path.')
        return result

    def read(self, ref, limit=MAX_BYTES):
        with self.path(ref).open('rb') as f:
            return bounded(f.read(limit + 1), limit)

    def write(self, key, data, reference=None, limit=MAX_BYTES):
        path = self.path(reference or key)
        if reference is None and path.exists():
            raise StorageError('A file with that name already exists.')
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name + '.tmp-' + secrets.token_hex(8))
        try:
            with temp.open('xb') as f:
                f.write(bounded(data, limit))
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)
        return reference or key

    def move(self, ref, key):
        source, destination = self.path(ref), self.path(key)
        if source == destination:
            return key
        if destination.exists():
            raise StorageError('A file with that name already exists.')
        destination.parent.mkdir(parents=True, exist_ok=True)
        source.rename(destination)
        return key

    def delete(self, ref):
        self.path(ref).unlink(missing_ok=True)

    def ensure_dir(self, key):
        self.path(key).mkdir(parents=True, exist_ok=True)

    def scan(self):
        root = Path(self.config['root']).resolve()
        for path in root.rglob('*'):
            if path.is_file() and not any(part.startswith('.yourwiki-') for part in path.parts):
                yield path.relative_to(root).as_posix(), path.relative_to(root).as_posix()

class HTTP(Adapter):
    def request(self, method, url, **kwargs):
        try:
            allowed_status = kwargs.pop('allowed_status', ())
            response = requests.request(method, url, timeout=(10, 45), **kwargs)
            if response.status_code not in allowed_status:
                response.raise_for_status()
            return response
        except requests.RequestException:
            # Provider responses and URLs can contain credentials: never expose them.
            raise StorageError('The storage provider could not complete the request.') from None

    def download(self, url, limit=MAX_BYTES, **kwargs):
        with self.request('GET', url, stream=True, **kwargs) as response:
            data = bytearray()
            for part in response.iter_content(65536):
                data.extend(part)
                bounded(data, limit)
            return bytes(data)

# Serialize refreshes on the shared adapter in the single application process.
_refresh_lock = threading.Lock()

class OAuthHTTP(HTTP):
    def token(self):
        with _refresh_lock:
            c = self.config
            endpoint = 'https://oauth2.googleapis.com/token' if c['provider'] == 'google' else f"https://login.microsoftonline.com/{quote(c.get('tenant', 'common'), safe='')}/oauth2/v2.0/token"
            payload = {'grant_type': 'refresh_token', 'client_id': c['client_id'], 'client_secret': c['client_secret'], 'refresh_token': c['refresh_token']}
            if c['provider'] == 'onedrive':
                payload['scope'] = 'offline_access Files.ReadWrite'
            result = self.request('POST', endpoint, data=payload).json()
            if result.get('refresh_token'):
                c['refresh_token'] = result['refresh_token']
                self.save_config(c)
            return result['access_token']

    def headers(self):
        return {'Authorization': 'Bearer ' + self.token()}

class GoogleDrive(OAuthHTTP):
    def location(self, ref):
        parts, current = [], ref
        for _ in range(34):
            if current == self.config['root']:
                return '/'.join(reversed(parts))
            if not current: break
            info = self.request('GET', self.base + '/' + quote(current, safe=''), headers=self.headers()).json()
            parts.append(info['name'])
            current = info.get('parents', [None])[0]
        raise StorageError('The original file is outside the configured storage directory.')

    def original_url(self, ref):
        return 'https://drive.google.com/file/d/' + quote(ref, safe='') + '/view'

    base = 'https://www.googleapis.com/drive/v3/files'

    def create_root(self, name):
        result = self.request('POST', self.base, headers=self.headers(), json={'name': name, 'mimeType': 'application/vnd.google-apps.folder'}, params={'fields': 'id'}).json()
        self.config['root'] = result['id']
        self.save_config(self.config)

    def read(self, ref, limit=MAX_BYTES):
        return self.download(self.base + '/' + quote(ref, safe=''), limit=limit, headers=self.headers(), params={'alt': 'media'})

    def write(self, key, data, reference=None, limit=MAX_BYTES):
        safe_key(key)
        data = bounded(data, limit)
        if reference:
            self.request('PATCH', 'https://www.googleapis.com/upload/drive/v3/files/' + quote(reference, safe=''), headers={**self.headers(), 'Content-Type': 'application/octet-stream'}, params={'uploadType': 'media'}, data=data)
            return reference
        boundary = 'yourwiki' + secrets.token_hex(12)
        parent = self.directory(key.rpartition('/')[0])
        import mimetypes
        metadata = json.dumps({'name': key.rpartition('/')[2], 'parents': [parent], 'mimeType': mimetypes.guess_type(key)[0] or 'application/octet-stream'})
        payload = (f'--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + data + f'\r\n--{boundary}--\r\n'.encode())
        return self.request('POST', 'https://www.googleapis.com/upload/drive/v3/files', headers={**self.headers(), 'Content-Type': f'multipart/related; boundary={boundary}'}, params={'uploadType': 'multipart', 'fields': 'id'}, data=payload).json()['id']

    def move(self, ref, key):
        safe_key(key)
        parent = self.directory(key.rpartition('/')[0])
        info = self.request('GET', self.base + '/' + quote(ref, safe=''), headers=self.headers(), params={'fields': 'parents'}).json()
        parents = info.get('parents', [])
        params = {'fields': 'id'}
        if parent not in parents:
            params.update(addParents=parent, removeParents=','.join(parents))
        self.request('PATCH', self.base + '/' + quote(ref, safe=''), headers=self.headers(),
                     params=params, json={'name': key.rsplit('/', 1)[-1]})
        return ref

    def delete(self, ref):
        self.request('DELETE', self.base + '/' + quote(ref, safe=''), headers=self.headers(), allowed_status=(404,))

    def directory(self, key):
        parent = self.config['root']
        for part in key.split('/') if key else []:
            escaped = part.replace('\\', '\\\\').replace("'", "\\'")
            response = self.request('GET', self.base, headers=self.headers(), params={
                'q': f"'{parent}' in parents and name = '{escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
                'fields':'files(id)', 'pageSize':2}).json().get('files', [])
            if len(response) > 1:
                raise StorageError('Ambiguous storage directory.')
            parent = response[0]['id'] if response else self.request('POST', self.base, headers=self.headers(), json={
                'name':part, 'mimeType':'application/vnd.google-apps.folder', 'parents':[parent]}, params={'fields':'id'}).json()['id']
        return parent

    def ensure_dir(self, key):
        safe_key(key)
        self.directory(key)

    def scan(self):
        def walk(parent, prefix=''):
            response = self.request('GET', self.base, headers=self.headers(), params={
                'q': f"'{parent}' in parents and trashed = false",
                'fields': 'files(id,name,mimeType)', 'pageSize': 1000}).json()
            for item in response.get('files', []):
                key = f'{prefix}/{item["name"]}' if prefix else item['name']
                if item['mimeType'] == 'application/vnd.google-apps.folder':
                    yield from walk(item['id'], key)
                else:
                    yield key, item['id']
        yield from walk(self.config['root'])

class OneDrive(OAuthHTTP):
    def location(self, ref):
        parts, current = [], ref
        for _ in range(34):
            if current == self.config['root']:
                return '/'.join(reversed(parts))
            if not current: break
            info = self.request('GET', self.base + '/items/' + quote(current, safe=''), headers=self.headers()).json()
            parts.append(info['name'])
            current = info.get('parentReference', {}).get('id')
        raise StorageError('The original file is outside the configured storage directory.')

    def original_url(self, ref):
        from urllib.parse import urlsplit
        value = self.request('GET', self.base + '/items/' + quote(ref, safe=''), headers=self.headers(), params={'$select': 'webUrl'}).json().get('webUrl', '')
        return value if urlsplit(value).scheme == 'https' and not urlsplit(value).username else ''

    base = 'https://graph.microsoft.com/v1.0/me/drive'

    def create_root(self, name):
        result = self.request('POST', self.base + '/root/children', headers=self.headers(), json={'name': name, 'folder': {}, '@microsoft.graph.conflictBehavior': 'rename'}).json()
        self.config['root'] = result['id']
        self.save_config(self.config)

    def read(self, ref, limit=MAX_BYTES):
        # requests strips Authorization when redirected to a different download host.
        return self.download(self.base + '/items/' + quote(ref, safe='') + '/content', limit=limit, headers=self.headers())

    def write(self, key, data, reference=None, limit=MAX_BYTES):
        safe_key(key)
        url = self.base + '/items/' + quote(reference, safe='') + '/content' if reference else self.base + '/items/' + quote(self.config['root'], safe='') + ':/' + quote(key, safe='/') + ':/content'
        return self.request('PUT', url, headers={**self.headers(), 'Content-Type': 'application/octet-stream'}, params={} if reference else {'@microsoft.graph.conflictBehavior': 'fail'}, data=bounded(data, limit)).json()['id']

    def move(self, ref, key):
        safe_key(key)
        directory, _, name = key.rpartition('/')
        parent = self.config['root']
        if directory:
            self.ensure_dir(directory)
            parent = self.request('GET', self.base + '/items/' + quote(parent, safe='') + ':/' + quote(directory, safe='/'), headers=self.headers()).json()['id']
        self.request('PATCH', self.base + '/items/' + quote(ref, safe=''), headers=self.headers(), json={'name': name, 'parentReference': {'id': parent}})
        return ref

    def delete(self, ref):
        self.request('DELETE', self.base + '/items/' + quote(ref, safe=''), headers=self.headers(), allowed_status=(404,))

    def ensure_dir(self, key):
        safe_key(key)
        parent = self.config['root']
        for part in key.split('/'):
            existing = self.request('GET', self.base + '/items/' + quote(parent, safe='') + ':/' + quote(part, safe=''),
                                    headers=self.headers(), allowed_status=(404,))
            parent = existing.json()['id'] if existing.status_code != 404 else self.request('POST',
                self.base + '/items/' + quote(parent, safe='') + '/children', headers=self.headers(),
                json={'name':part, 'folder':{}, '@microsoft.graph.conflictBehavior':'fail'}).json()['id']

class GitHub(HTTP):
    def original_url(self, ref):
        path = '/'.join(p for p in (self.config.get('root', '').strip('/'), ref) if p)
        return 'https://github.com/' + '/'.join(quote(p, safe='') for p in self.config['repository'].split('/')) + '/blob/' + quote(self.config['branch'], safe='') + '/' + quote(path, safe='/')

    def url(self, key):
        safe_key(key)
        root = self.config.get('root', '').strip('/')
        path = f'{root}/{key}' if root else key
        return 'https://api.github.com/repos/' + '/'.join(quote(p, safe='') for p in self.config['repository'].split('/')) + '/contents/' + quote(path, safe='/')

    def headers(self):
        return {'Authorization': 'Bearer ' + self.config['token'], 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}

    def info(self, ref):
        return self.request('GET', self.url(ref), headers=self.headers(), params={'ref': self.config['branch']}).json()

    def read(self, ref, limit=MAX_BYTES):
        return self.download(self.url(ref), limit=limit, headers={**self.headers(), 'Accept': 'application/vnd.github.raw+json'}, params={'ref': self.config['branch']})

    def write(self, key, data, reference=None, limit=MAX_BYTES):
        body = {'message': 'Yourwiki: save document revision', 'branch': self.config['branch'], 'content': base64.b64encode(bounded(data, limit)).decode()}
        if reference:
            body['sha'] = self.info(reference)['sha']
        self.request('PUT', self.url(reference or key), headers=self.headers(), json=body)
        return reference or key

    def move(self, ref, key):
        safe_key(key)
        if ref == key:
            return key
        base = 'https://api.github.com/repos/' + '/'.join(quote(p, safe='') for p in self.config['repository'].split('/')) + '/git/'
        branch = 'heads/' + quote(self.config['branch'], safe='')
        head = self.request('GET', base + 'ref/' + branch, headers=self.headers()).json()['object']['sha']
        existing = self.request('GET', self.url(key), headers=self.headers(), params={'ref': head}, allowed_status=(404,))
        if existing.status_code != 404:
            raise StorageError('A file with that name already exists.')
        commit = self.request('GET', base + 'commits/' + head, headers=self.headers()).json()
        root = self.config.get('root', '').strip('/')
        prefix = root + '/' if root else ''
        info = self.request('GET', self.url(ref), headers=self.headers(), params={'ref': head}).json()
        tree = self.request('POST', base + 'trees', headers=self.headers(), json={'base_tree': commit['tree']['sha'], 'tree': [
            {'path': prefix + ref, 'mode': '100644', 'type': 'blob', 'sha': None},
            {'path': prefix + key, 'mode': '100644', 'type': 'blob', 'sha': info['sha']},
        ]}).json()['sha']
        new_commit = self.request('POST', base + 'commits', headers=self.headers(), json={'message': 'Yourwiki: move file', 'tree': tree, 'parents': [head]}).json()['sha']
        self.request('PATCH', base + 'refs/' + branch, headers=self.headers(), json={'sha': new_commit, 'force': False})
        return key

    def delete(self, ref):
        response = self.request('GET', self.url(ref), headers=self.headers(), params={'ref': self.config['branch']}, allowed_status=(404,))
        if getattr(response, 'status_code', 200) == 404:
            return
        self.request('DELETE', self.url(ref), headers=self.headers(), json={'message': 'Yourwiki: delete file', 'branch': self.config['branch'], 'sha': response.json()['sha']}, allowed_status=(404,))

    def ensure_dir(self, key):
        # Git does not represent empty directories; a marker keeps them visible.
        marker = safe_key(key) + '/.yourwiki-directory'
        response = self.request('GET', self.url(marker), headers=self.headers(), params={'ref':self.config['branch']}, allowed_status=(404,))
        if response.status_code == 404:
            self.write(marker, b'')

class SFTP(Adapter):
    @contextlib.contextmanager
    def client(self):
        import paramiko
        c = self.config
        client = paramiko.SSHClient()
        host = c['host'] if int(c.get('port', 22)) == 22 else f"[{c['host']}]:{c['port']}"
        entry = paramiko.hostkeys.HostKeyEntry.from_line(host + ' ' + c['host_key'])
        if not entry:
            raise StorageError('Invalid SSH host key.')
        client.get_host_keys().add(host, entry.key.get_name(), entry.key)
        key = paramiko.PKey.from_path(c['key_file'], passphrase=c.get('key_passphrase')) if c.get('key_file') else None
        if c.get('private_key'):
            for cls in (paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.RSAKey):
                try:
                    key = cls.from_private_key(io.StringIO(c['private_key']), password=c.get('key_passphrase') or None)
                    break
                except paramiko.SSHException:
                    continue
            if key is None:
                raise StorageError('Invalid SSH private key.')
        try:
            client.connect(c['host'], port=int(c.get('port', 22)), username=c['username'], password=c.get('password') or None, pkey=key, allow_agent=False, look_for_keys=False, timeout=10, auth_timeout=15, banner_timeout=15)
            with client.open_sftp() as sftp:
                sftp.get_channel().settimeout(45)
                yield sftp
        finally:
            client.close()

    def path(self, ref):
        return posixpath.join(self.config['root'], safe_key(ref))

    def read(self, ref, limit=MAX_BYTES):
        with self.client() as c, c.open(self.path(ref), 'rb') as f:
            return bounded(f.read(limit + 1), limit)

    def write(self, key, data, reference=None, limit=MAX_BYTES):
        data = bounded(data, limit)
        ref = reference or safe_key(key)
        if '/' in ref:
            self.ensure_dir(ref.rpartition('/')[0])
        temporary = self.path(ref) + '.yourwiki-tmp-' + secrets.token_hex(8)
        with self.client() as client:
            try:
                with client.open(temporary, 'wx') as stream:
                    stream.write(data)
                    stream.flush()
                if reference:
                    # OpenSSH extension: fail safely if atomic replacement is unsupported.
                    client.posix_rename(temporary, self.path(ref))
                else:
                    client.rename(temporary, self.path(ref))
            finally:
                try: client.remove(temporary)
                except FileNotFoundError: pass
        return ref

    def move(self, ref, key):
        safe_key(key)
        if ref == key: return key
        if '/' in key: self.ensure_dir(key.rpartition('/')[0])
        with self.client() as client:
            client.rename(self.path(ref), self.path(key))
        return key

    def delete(self, ref):
        with self.client() as c:
            try:
                c.remove(self.path(ref))
            except FileNotFoundError:
                pass

    def ensure_dir(self, key):
        safe_key(key)
        with self.client() as c:
            current = self.config['root'].rstrip('/')
            for part in key.split('/'):
                current = posixpath.join(current, part)
                try:
                    c.mkdir(current)
                except OSError:
                    if not stat.S_ISDIR(c.stat(current).st_mode):
                        raise StorageError('Storage directory is unavailable.')

class SMB(Adapter):
    def client(self):
        import smbclient
        c = self.config
        username = (c['domain'] + '\\' if c.get('domain') else '') + c['username']
        smbclient.register_session(c['host'], username=username, password=c['password'], port=int(c.get('port', 445)), connection_timeout=15, require_signing=True)
        return smbclient

    def path(self, ref):
        safe_key(ref)
        c = self.config
        root = c.get('root', '').strip('/\\').replace('/', '\\')
        return '\\\\' + c['host'] + '\\' + c['share'] + '\\' + (root + '\\' if root else '') + ref.replace('/', '\\')

    def read(self, ref, limit=MAX_BYTES):
        with self.client().open_file(self.path(ref), mode='rb', port=int(self.config.get('port', 445))) as f:
            return bounded(f.read(limit + 1), limit)

    def write(self, key, data, reference=None, limit=MAX_BYTES):
        data = bounded(data, limit)
        ref = reference or safe_key(key)
        if '/' in ref:
            self.ensure_dir(ref.rpartition('/')[0])
        client = self.client()
        temporary = self.path(ref) + '.yourwiki-tmp-' + secrets.token_hex(8)
        port = int(self.config.get('port', 445))
        try:
            with client.open_file(temporary, mode='xb', port=port) as stream:
                stream.write(data)
            operation = client.replace if reference else client.rename
            operation(temporary, self.path(ref), port=port)
        finally:
            try: client.remove(temporary, port=port)
            except FileNotFoundError: pass
        return ref

    def move(self, ref, key):
        safe_key(key)
        if ref == key: return key
        if '/' in key: self.ensure_dir(key.rpartition('/')[0])
        self.client().rename(self.path(ref), self.path(key), port=int(self.config.get('port', 445)))
        return key

    def delete(self, ref):
        try:
            self.client().remove(self.path(ref), port=int(self.config.get('port', 445)))
        except FileNotFoundError:
            pass

    def ensure_dir(self, key):
        safe_key(key)
        self.client().makedirs(self.path(key), exist_ok=True)

ADAPTERS = {'local': Local, 'google': GoogleDrive, 'onedrive': OneDrive, 'github': GitHub, 'smb': SMB, 'sftp': SFTP}

class SafeAdapter:
    def __init__(self, adapter):
        self.adapter = adapter

    def __getattr__(self, method):
        def invoke(*args, **kwargs):
            try:
                return getattr(self.adapter, method)(*args, **kwargs)
            except StorageError:
                raise
            except Exception:
                raise StorageError('Storage is unavailable. Check the connection and try again.') from None
        return invoke

def root_mount():
    from .models import MountPoint, Workspace
    mount = MountPoint.objects.filter(path='/').first()
    if mount:
        return mount
    # Also covers a fresh installer: migrations run before its first workspace exists.
    workspace = Workspace.objects.get(pk=1, initialized=True)
    return MountPoint.objects.get_or_create(path='/', defaults={
        'provider': workspace.provider, 'encrypted_config': workspace.encrypted_config})[0]


_mount_cache = {}
_adapter_lock = threading.Lock()


def mount_adapter(mount):
    from .models import MountPoint, Workspace
    from .crypto import decrypt, encrypt
    def persist(updated):
        value = encrypt(updated)
        MountPoint.objects.filter(pk=mount.pk).update(encrypted_config=value)
        if mount.path == '/':
            Workspace.objects.filter(pk=1).update(encrypted_config=value)
        _mount_cache[mount.pk] = (value, adapter)

    with _adapter_lock:
        mount = MountPoint.objects.get(pk=mount.pk)
        cached = _mount_cache.get(mount.pk)
        if cached and cached[0] == mount.encrypted_config:
            return cached[1]
        adapter = SafeAdapter(ADAPTERS[mount.provider](decrypt(mount.encrypted_config), persist))
        _mount_cache[mount.pk] = (mount.encrypted_config, adapter)
        return adapter


class MountedStorage:
    """Route logical paths; references retain mount identity across later moves."""
    def resolve(self, key):
        from .models import MountPoint
        safe_key(key)
        path = '/' + key
        root = root_mount()
        matches = [mount for mount in MountPoint.objects.all()
                   if mount.path == '/' or path == mount.path or path.startswith(mount.path + '/')]
        mount = max(matches, key=lambda item: len(item.path), default=root)
        relative = key if mount.path == '/' else path[len(mount.path):].lstrip('/')
        return mount, relative

    def reference(self, value):
        from .models import MountPoint
        if value.startswith('mount:'):
            try:
                _, mount_id, ref = value.split(':', 2)
                return MountPoint.objects.get(pk=int(mount_id)), ref
            except (ValueError, MountPoint.DoesNotExist):
                raise StorageError('The file mount is unavailable.') from None
        return root_mount(), value

    def location(self, reference):
        mount, ref = self.reference(reference)
        key = mount_adapter(mount).location(ref)
        return key if mount.path == '/' else mount.path.strip('/') + '/' + key

    def original_url(self, reference):
        mount, ref = self.reference(reference)
        return mount_adapter(mount).original_url(ref)

    def read(self, reference, limit=MAX_BYTES):
        mount, ref = self.reference(reference)
        return mount_adapter(mount).read(ref, limit=limit)

    def write(self, key, data, reference=None, limit=MAX_BYTES):
        mount, relative = self.reference(reference) if reference else self.resolve(key)
        if not relative:
            raise StorageError('Cannot write a file over a mountpoint.')
        adapter = mount_adapter(mount)
        if not reference and '/' in relative:
            adapter.ensure_dir(relative.rpartition('/')[0])
        ref = adapter.write(relative, data, relative if reference else None, limit=limit)
        return ref if mount.path == '/' else f'mount:{mount.pk}:{ref}'

    def move(self, reference, key):
        source, ref = self.reference(reference)
        destination, relative = self.resolve(key)
        if source.pk == destination.pk:
            moved = mount_adapter(source).move(ref, relative)
            return moved if source.path == '/' else f'mount:{source.pk}:{moved}'
        # Different services have no shared rename operation. Verify before removing the source.
        data = self.read(reference)
        moved = self.write(key, data)
        if self.read(moved) != data:
            raise StorageError('The moved file could not be verified. The original was retained.')
        try:
            self.delete(reference)
        except Exception:
            self.delete(moved)
            raise
        return moved

    def delete(self, reference):
        mount, ref = self.reference(reference)
        mount_adapter(mount).delete(ref)

    def ensure_dir(self, key):
        mount, relative = self.resolve(key)
        if relative:
            mount_adapter(mount).ensure_dir(relative)

    def probe(self):
        from .models import MountPoint
        root_mount()
        for mount in MountPoint.objects.all():
            mount_adapter(mount).probe()

    def scan(self):
        from .models import MountPoint
        mount = root_mount()
        adapter = mount_adapter(mount)
        if not hasattr(adapter.adapter, 'scan'):
            raise StorageError('Root scanning is not supported by this provider.')
        for key, reference in adapter.scan():
            yield key, reference if mount.path == '/' else f'mount:{mount.pk}:{reference}'


def active_storage():
    return MountedStorage()
