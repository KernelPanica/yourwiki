"""Direct Python storage adapters. References are private, never sent to browsers."""
import base64
import contextlib
import io
import json
import hashlib
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

    def fingerprint(self, ref, data):
        return hashlib.sha256(data).hexdigest()

    def file_format(self, ref, key):
        suffix = PurePosixPath(key).suffix.lower().lstrip('.')
        return suffix if suffix in ('md', 'docx', 'ods') else ''

    def move_to(self, ref, destination, key):
        raise StorageError('These mounts cannot move the same provider object. Choose a directory on the same source; copying is not performed.')

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

    def move_to(self, ref, destination, key):
        source, target = self.path(ref), destination.path(key)
        if source == target:
            return key
        if target.exists():
            raise StorageError('A file with that name already exists.')
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            source.rename(target)
        except OSError as error:
            import errno
            if error.errno == errno.EXDEV:
                raise StorageError('These directories are on different filesystems. A native move is unavailable; the original was retained and no copy was made.') from None
            raise
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
    sheet_mime = 'application/vnd.google-apps.spreadsheet'
    ods_mime = 'application/vnd.oasis.opendocument.spreadsheet'

    def private_info(self, ref):
        info = self.request('GET', self.base + '/' + quote(ref, safe=''), headers=self.headers(),
            params={'fields': 'id,name,mimeType,parents,version,ownedByMe,shared,driveId,owners(permissionId)'}).json()
        if info.get('ownedByMe') is not True or info.get('shared') is not False or info.get('driveId'):
            raise StorageError('Google storage must be private and owned by the connected account. Shared files, shared folders and shared drives are not supported; no sharing permissions were changed.')
        return info

    def probe(self):
        root = self.private_info(self.config['root'])
        if root.get('mimeType') != 'application/vnd.google-apps.folder':
            raise StorageError('Choose a private Google Drive folder owned by the connected account.')
        super().probe()

    def available(self, parent, name, reference=None):
        escaped = name.replace('\\', '\\\\').replace("'", "\\'")
        files = self.request('GET', self.base, headers=self.headers(), params={
            'q': f"'{parent}' in parents and name = '{escaped}' and trashed = false",
            'fields': 'files(id)', 'pageSize': 2}).json().get('files', [])
        if any(item.get('id') != reference for item in files):
            raise StorageError('A file with that name already exists.')
    def location(self, ref):
        parts, current = [], ref
        for _ in range(34):
            if current == self.config['root']:
                return '/'.join(reversed(parts))
            if not current: break
            info = self.private_info(current)
            parts.append(info['name'])
            current = info.get('parents', [None])[0]
        raise StorageError('The original file is outside the configured storage directory.')

    def original_url(self, ref):
        info = self.private_info(ref)
        if info.get('mimeType') == self.sheet_mime:
            return 'https://docs.google.com/spreadsheets/d/' + quote(ref, safe='') + '/edit'
        return 'https://drive.google.com/file/d/' + quote(ref, safe='') + '/view'

    base = 'https://www.googleapis.com/drive/v3/files'

    def create_root(self, name):
        result = self.request('POST', self.base, headers=self.headers(), json={'name': name, 'mimeType': 'application/vnd.google-apps.folder'}, params={'fields': 'id'}).json()
        self.config['root'] = result['id']
        self.save_config(self.config)

    def read(self, ref, limit=MAX_BYTES):
        info = self.private_info(ref)
        url = self.base + '/' + quote(ref, safe='')
        native = info.get('mimeType') == self.sheet_mime
        data = self.download(url + '/export' if native else url, limit=limit, headers=self.headers(),
                             params={'mimeType': self.ods_mime} if native else {'alt': 'media'})
        if native:
            after = self.private_info(ref)
            if info.get('version') != after.get('version') or not info.get('version'):
                raise StorageError('Google Sheets changed while being read. Reload the file before saving.')
            self.__dict__.setdefault('_sheet_snapshots', {})[ref] = (hashlib.sha256(data).hexdigest(), str(info['version']))
        return data

    def fingerprint(self, ref, data):
        snapshot = getattr(self, '_sheet_snapshots', {}).get(ref)
        if snapshot and snapshot[0] == hashlib.sha256(data).hexdigest():
            return hashlib.sha256(('google-sheet:' + snapshot[1]).encode()).hexdigest()
        return super().fingerprint(ref, data)

    def file_format(self, ref, key):
        return 'ods' if self.private_info(ref).get('mimeType') == self.sheet_mime else super().file_format(ref, key)

    def write(self, key, data, reference=None, limit=MAX_BYTES):
        safe_key(key)
        data = bounded(data, limit)
        import mimetypes
        source_mime = mimetypes.guess_type(key)[0] or 'application/octet-stream'
        # Only standard ODS containers are converted, never a binary upload
        # that happens to have an .ods filename.
        native = False
        if source_mime == self.ods_mime:
            from .file_formats import checked_archive
            try:
                with checked_archive(data) as archive:
                    native = archive.read('mimetype').decode() == self.ods_mime
            except Exception:
                raise StorageError('Choose a valid ODS spreadsheet.') from None
        if reference:
            info = self.private_info(reference)
            native = native or info.get('mimeType') == self.sheet_mime
            if not native:
                self.request('PATCH', 'https://www.googleapis.com/upload/drive/v3/files/' + quote(reference, safe=''), headers={**self.headers(), 'Content-Type': source_mime}, params={'uploadType': 'media'}, data=data)
                return reference
        boundary = 'yourwiki' + secrets.token_hex(12)
        metadata = {'name': key.rpartition('/')[2], 'mimeType': self.sheet_mime if native else source_mime}
        if not reference:
            metadata['parents'] = [self.directory(key.rpartition('/')[0])]
            self.available(metadata['parents'][0], metadata['name'])
        payload = (f'--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{json.dumps(metadata)}\r\n--{boundary}\r\nContent-Type: {source_mime}\r\n\r\n'.encode() + data + f'\r\n--{boundary}--\r\n'.encode())
        url = 'https://www.googleapis.com/upload/drive/v3/files' + ('/' + quote(reference, safe='') if reference else '')
        if len(data) > MAX_BYTES:
            from urllib.parse import urlsplit
            response = self.request('PATCH' if reference else 'POST', url,
                headers={**self.headers(), 'X-Upload-Content-Type': source_mime,
                         'X-Upload-Content-Length': str(len(data)), 'Content-Type': 'application/json'},
                params={'uploadType': 'resumable', 'fields': 'id,version'}, json=metadata)
            session = response.headers.get('Location', '')
            parsed = urlsplit(session)
            if parsed.scheme != 'https' or parsed.hostname != 'www.googleapis.com' or parsed.username:
                raise StorageError('Google returned an invalid upload session. The original was not overwritten.')
            ref = self.request('PUT', session, headers={**self.headers(), 'Content-Type': source_mime}, data=data).json()['id']
        else:
            ref = self.request('PATCH' if reference else 'POST', url, headers={**self.headers(), 'Content-Type': f'multipart/related; boundary={boundary}'}, params={'uploadType': 'multipart', 'fields': 'id,version'}, data=payload).json()['id']
        if native:
            info = self.private_info(ref)
            if not info.get('version'):
                raise StorageError('Google Sheets did not return a file version. Reload before saving again.')
            self.__dict__.setdefault('_sheet_snapshots', {})[ref] = (hashlib.sha256(data).hexdigest(), str(info['version']))
        return ref

    def move(self, ref, key):
        safe_key(key)
        parent = self.directory(key.rpartition('/')[0])
        self.available(parent, key.rsplit('/', 1)[-1], ref)
        info = self.private_info(ref)
        parents = info.get('parents', [])
        params = {'fields': 'id'}
        if parent not in parents:
            params.update(addParents=parent, removeParents=','.join(parents))
        self.request('PATCH', self.base + '/' + quote(ref, safe=''), headers=self.headers(),
                     params=params, json={'name': key.rsplit('/', 1)[-1]})
        return ref

    def move_to(self, ref, destination, key):
        source_root = self.private_info(self.config['root'])
        target_root = destination.private_info(destination.config['root'])
        if not source_root.get('owners') or source_root['owners'] != target_root.get('owners'):
            raise StorageError('Google mounts must use the same owner account for a native move.')
        self.private_info(ref)
        return destination.move(ref, key)

    def delete(self, ref):
        self.request('DELETE', self.base + '/' + quote(ref, safe=''), headers=self.headers(), allowed_status=(404,))

    def directory(self, key):
        parent = self.config['root']
        self.private_info(parent)
        for part in key.split('/') if key else []:
            escaped = part.replace('\\', '\\\\').replace("'", "\\'")
            response = self.request('GET', self.base, headers=self.headers(), params={
                'q': f"'{parent}' in parents and name = '{escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
                'fields':'files(id)', 'pageSize':2}).json().get('files', [])
            if len(response) > 1:
                raise StorageError('Ambiguous storage directory.')
            parent = response[0]['id'] if response else self.request('POST', self.base, headers=self.headers(), json={
                'name':part, 'mimeType':'application/vnd.google-apps.folder', 'parents':[parent]}, params={'fields':'id'}).json()['id']
            self.private_info(parent)
        return parent

    def ensure_dir(self, key):
        safe_key(key)
        self.directory(key)

    def scan(self):
        def walk(parent, prefix=''):
            token = None
            while True:
                params = {'q': f"'{parent}' in parents and trashed = false",
                          'fields': 'nextPageToken,files(id,name,mimeType)', 'pageSize': 1000}
                if token:
                    params['pageToken'] = token
                response = self.request('GET', self.base, headers=self.headers(), params=params).json()
                for item in response.get('files', []):
                    key = f'{prefix}/{item["name"]}' if prefix else item['name']
                    if item['mimeType'] == 'application/vnd.google-apps.folder':
                        yield from walk(item['id'], key)
                    else:
                        yield key, item['id']
                token = response.get('nextPageToken')
                if not token:
                    break
        yield from walk(self.config['root'])

class OneDrive(OAuthHTTP):
    def private_info(self, ref):
        info = self.request('GET', self.base + '/items/' + quote(ref, safe=''), headers=self.headers(),
                            params={'$select': 'id,name,webUrl,parentReference,remoteItem,shared'}).json()
        owner = self.request('GET', self.base, headers=self.headers(), params={'$select': 'owner'}).json().get('owner', {}).get('user', {}).get('id')
        permissions = self.request('GET', self.base + '/items/' + quote(ref, safe='') + '/permissions', headers=self.headers()).json()
        if not owner or info.get('remoteItem') or info.get('shared') or not isinstance(permissions.get('value'), list) or permissions.get('@odata.nextLink'):
            raise StorageError('OneDrive privacy could not be verified. Use the connected account\'s private personal drive.')
        for permission in permissions.get('value', []):
            principals = permission.get('grantedToIdentitiesV2', permission.get('grantedToIdentities', []))
            principal = permission.get('grantedToV2', permission.get('grantedTo'))
            if principal:
                principals = [*principals, principal]
            if permission.get('link') or permission.get('invitation') or not principals or any(p.get('user', {}).get('id') != owner for p in principals):
                raise StorageError('OneDrive files must be accessible only to the connected account. No sharing permissions were changed.')
        return info

    def probe(self):
        self.private_info(self.config['root'])
        super().probe()

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
        value = self.private_info(ref).get('webUrl', '')
        return value if urlsplit(value).scheme == 'https' and not urlsplit(value).username else ''

    base = 'https://graph.microsoft.com/v1.0/me/drive'

    def create_root(self, name):
        result = self.request('POST', self.base + '/root/children', headers=self.headers(), json={'name': name, 'folder': {}, '@microsoft.graph.conflictBehavior': 'rename'}).json()
        self.config['root'] = result['id']
        self.save_config(self.config)

    def read(self, ref, limit=MAX_BYTES):
        # requests strips Authorization when redirected to a different download host.
        self.private_info(ref)
        return self.download(self.base + '/items/' + quote(ref, safe='') + '/content', limit=limit, headers=self.headers())

    def write(self, key, data, reference=None, limit=MAX_BYTES):
        safe_key(key)
        self.private_info(reference or self.config['root'])
        url = self.base + '/items/' + quote(reference, safe='') + '/content' if reference else self.base + '/items/' + quote(self.config['root'], safe='') + ':/' + quote(key, safe='/') + ':/content'
        return self.request('PUT', url, headers={**self.headers(), 'Content-Type': 'application/octet-stream'}, params={} if reference else {'@microsoft.graph.conflictBehavior': 'fail'}, data=bounded(data, limit)).json()['id']

    def move(self, ref, key):
        safe_key(key)
        self.private_info(ref)
        self.private_info(self.config['root'])
        directory, _, name = key.rpartition('/')
        parent = self.config['root']
        if directory:
            self.ensure_dir(directory)
            parent = self.request('GET', self.base + '/items/' + quote(parent, safe='') + ':/' + quote(directory, safe='/'), headers=self.headers()).json()['id']
        self.request('PATCH', self.base + '/items/' + quote(ref, safe=''), headers=self.headers(), json={'name': name, 'parentReference': {'id': parent}})
        return ref

    def move_to(self, ref, destination, key):
        source_owner = self.request('GET', self.base, headers=self.headers(), params={'$select': 'id'}).json().get('id')
        target_owner = destination.request('GET', destination.base, headers=destination.headers(), params={'$select': 'id'}).json().get('id')
        if not source_owner or source_owner != target_owner:
            raise StorageError('OneDrive mounts must use the same drive for a native move.')
        self.private_info(ref)
        destination.private_info(destination.config['root'])
        return destination.move(ref, key)

    def delete(self, ref):
        self.request('DELETE', self.base + '/items/' + quote(ref, safe=''), headers=self.headers(), allowed_status=(404,))

    def ensure_dir(self, key):
        safe_key(key)
        parent = self.config['root']
        self.private_info(parent)
        for part in key.split('/'):
            existing = self.request('GET', self.base + '/items/' + quote(parent, safe='') + ':/' + quote(part, safe=''),
                                    headers=self.headers(), allowed_status=(404,))
            parent = existing.json()['id'] if existing.status_code != 404 else self.request('POST',
                self.base + '/items/' + quote(parent, safe='') + '/children', headers=self.headers(),
                json={'name':part, 'folder':{}, '@microsoft.graph.conflictBehavior':'fail'}).json()['id']
            self.private_info(parent)

class GitHub(HTTP):
    def private_repository(self):
        base = 'https://api.github.com/repos/' + '/'.join(quote(p, safe='') for p in self.config['repository'].split('/'))
        account = self.request('GET', 'https://api.github.com/user', headers=self.headers()).json().get('login')
        repo = self.request('GET', base, headers=self.headers()).json()
        collaborators = self.request('GET', base + '/collaborators', headers=self.headers(), params={'per_page': 100}).json()
        if not account or repo.get('private') is not True or repo.get('owner', {}).get('login') != account or repo.get('owner', {}).get('type') != 'User' or not isinstance(collaborators, list) or any(item.get('login') != account for item in collaborators):
            raise StorageError('Git storage must be a private personal repository with only the connected account as a collaborator. No repository permissions were changed.')

    def probe(self):
        self.private_repository()
        super().probe()

    def original_url(self, ref):
        self.private_repository()
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
        self.private_repository()
        return self.download(self.url(ref), limit=limit, headers={**self.headers(), 'Accept': 'application/vnd.github.raw+json'}, params={'ref': self.config['branch']})

    def write(self, key, data, reference=None, limit=MAX_BYTES):
        self.private_repository()
        body = {'message': 'Yourwiki: save document revision', 'branch': self.config['branch'], 'content': base64.b64encode(bounded(data, limit)).decode()}
        if reference:
            body['sha'] = self.info(reference)['sha']
        self.request('PUT', self.url(reference or key), headers=self.headers(), json=body)
        return reference or key

    def move(self, ref, key):
        safe_key(key)
        self.private_repository()
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

    def move_to(self, ref, destination, key):
        if any(self.config.get(name) != destination.config.get(name) for name in ('repository', 'branch')):
            return super().move_to(ref, destination, key)
        destination.private_repository()
        # Resolve both roots against one Git tree; no blob data is downloaded.
        prefix = self.config.get('root', '').strip('/')
        target_prefix = destination.config.get('root', '').strip('/')
        adapter = GitHub({**self.config, 'root': ''})
        return_key = key
        adapter.move('/'.join(p for p in (prefix, ref) if p), '/'.join(p for p in (target_prefix, key) if p))
        return return_key

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

    def move_to(self, ref, destination, key):
        identity = ('host', 'username', 'host_key')
        if any(self.config.get(name) != destination.config.get(name) for name in identity) or int(self.config.get('port', 22)) != int(destination.config.get('port', 22)):
            return super().move_to(ref, destination, key)
        if '/' in key:
            destination.ensure_dir(key.rpartition('/')[0])
        with self.client() as client:
            client.rename(self.path(ref), destination.path(key))
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

    def move_to(self, ref, destination, key):
        identity = ('host', 'share', 'username', 'domain')
        if any(self.config.get(name, '') != destination.config.get(name, '') for name in identity) or int(self.config.get('port', 445)) != int(destination.config.get('port', 445)):
            return super().move_to(ref, destination, key)
        if '/' in key:
            destination.ensure_dir(key.rpartition('/')[0])
        self.client().rename(self.path(ref), destination.path(key), port=int(self.config.get('port', 445)))
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

    def fingerprint(self, reference, data):
        mount, ref = self.reference(reference)
        return mount_adapter(mount).fingerprint(ref, data)

    def file_format(self, reference, key):
        mount, ref = self.reference(reference)
        return mount_adapter(mount).file_format(ref, key)

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
        if source.provider != destination.provider:
            raise StorageError('A native move between different storage providers is unavailable. Choose a directory on the same source; no file was copied or deleted.')
        moved = mount_adapter(source).move_to(ref, mount_adapter(destination).adapter, relative)
        return moved if destination.path == '/' else f'mount:{destination.pk}:{moved}'

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
