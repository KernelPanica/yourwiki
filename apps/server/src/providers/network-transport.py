"""Private one-operation bridge. Credentials arrive exclusively on stdin.

stdout is a bounded JSON control channel; file bytes use private local staging.
Remote rename is optimistic concurrency, not a server-side compare-and-swap.
"""
import base64
import hashlib
import io
import json
import os
import posixpath
import re
import stat
import sys

CHUNK = 65536
MAX_ENTRIES = 10000


class Rejected(Exception):
    def __init__(self, code):
        self.code = code


def reject(code='PROVIDER_INVALID_REFERENCE'):
    raise Rejected(code)


def key(value, empty=False):
    if not isinstance(value, str) or len(value) > 4096 or (not value and not empty):
        reject()
    # Colons/ADS, DOS path aliases, UNC names and dot components are forbidden
    # for both protocols so a reference has the same meaning in every caller.
    if value and any(not p or p in ('.', '..') or p[-1] in '. ' or
                     any(ord(c) < 32 or c in '\\:*?"<>|' for c in p)
                     for p in value.split('/')):
        reject()
    return value


def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


class SFTP:
    def __init__(self, config):
        import paramiko
        self.owner = paramiko.SSHClient()
        host = config['host']
        port = int(config.get('port', 22))
        name = host if port == 22 else '[%s]:%s' % (host, port)
        pin = config.get('host_key', '')
        if not isinstance(pin, str) or not pin or '\n' in pin or '\r' in pin:
            reject('ACCESS_DENIED')
        # Keep the legacy explicit public-key format: "ssh-ed25519 AAAA...".
        entry = paramiko.hostkeys.HostKeyEntry.from_line(name + ' ' + pin)
        if not entry or not entry.key:
            reject('ACCESS_DENIED')
        self.owner.get_host_keys().add(name, entry.key.get_name(), entry.key)
        private = None
        if config.get('private_key'):
            for cls in (paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.RSAKey):
                try:
                    private = cls.from_private_key(io.StringIO(config['private_key']),
                                                   password=config.get('key_passphrase') or None)
                    break
                except (ValueError, paramiko.SSHException):
                    continue
            if private is None:
                reject('ACCESS_DENIED')
        self.owner.connect(host, port=port, username=config['username'],
                           password=config.get('password') or None, pkey=private,
                           allow_agent=False, look_for_keys=False, timeout=10,
                           auth_timeout=15, banner_timeout=15)
        self.client = self.owner.open_sftp()
        self.client.get_channel().settimeout(45)
        self.root = config.get('root', '/')
        if not isinstance(self.root, str) or not self.root.startswith('/'):
            reject()
        self.root = '/' + key(self.root.strip('/'), empty=True)
        self.root = self.root.rstrip('/') or '/'
        # Reject symlinks even in the configured root, not merely below it.
        self.validate('', directory=True)

    def path(self, reference):
        return posixpath.join(self.root, key(reference, empty=True))

    def lstat(self, path):
        return self.client.lstat(path)

    def validate(self, reference, directory=False, missing=False):
        target = self.path(reference)
        current = '/'
        parts = target.strip('/').split('/') if target != '/' else []
        info = self.lstat('/')
        for index, part in enumerate(parts):
            current = posixpath.join(current, part)
            try:
                info = self.lstat(current)
            except FileNotFoundError:
                if missing and index == len(parts)-1:
                    return None
                raise
            if stat.S_ISLNK(info.st_mode):
                reject()
            if index < len(parts)-1 and not stat.S_ISDIR(info.st_mode):
                reject()
        if directory and not stat.S_ISDIR(info.st_mode):
            reject()
        if not directory and not (stat.S_ISREG(info.st_mode) or missing):
            reject()
        return info

    def open(self, reference, mode):
        return self.client.open(self.path(reference), mode)

    def listing(self, reference):
        for index, item in enumerate(self.client.listdir_iter(self.path(reference))):
            if index >= MAX_ENTRIES:
                reject('PROVIDER_EXPORT_LIMIT')
            yield item.filename, item

    def rename(self, source, target, replace):
        if replace:
            self.client.posix_rename(self.path(source), self.path(target))
        else:
            # Standard SFTP rename fails when the destination exists.
            self.client.rename(self.path(source), self.path(target))

    def remove(self, reference):
        self.client.remove(self.path(reference))

    def close(self):
        self.owner.close()


class SMB:
    def __init__(self, config):
        import smbclient
        self.client = smbclient
        self.port = int(config.get('port', 445))
        host, share = config['host'], key(config['share'])
        if '/' in share or any(c in host for c in '/\\\x00'):
            reject()
        root = key(config.get('root', '').strip('/\\').replace('\\', '/'), empty=True)
        self.root = '\\\\' + host + '\\' + share
        self.prefix = self.root
        self.root_reference = root
        username = (config['domain'] + '\\' if config.get('domain') else '') + config['username']
        smbclient.register_session(host, username=username, password=config['password'],
                                   port=self.port, connection_timeout=15, require_signing=True)
        self.root += ('\\' + root.replace('/', '\\')) if root else ''
        self.validate('', directory=True)

    def path(self, reference):
        value = key(reference, empty=True)
        return self.root + ('\\' + value.replace('/', '\\') if value else '')

    def lstat(self, path):
        return self.client.lstat(path, port=self.port)

    def validate(self, reference, directory=False, missing=False):
        key(reference, empty=True)
        parts = '/'.join(p for p in (self.root_reference, reference) if p).split('/')
        current = self.prefix
        info = self.lstat(current)
        for index, part in enumerate(p for p in parts if p):
            current += '\\' + part
            try:
                info = self.lstat(current)
            except FileNotFoundError:
                if missing and index == len(parts)-1:
                    return None
                raise
            # Reject junctions and every other reparse point as well as symlinks.
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                reject()
            if index < len(parts)-1 and not stat.S_ISDIR(info.st_mode):
                reject()
        if directory and not stat.S_ISDIR(info.st_mode):
            reject()
        if not directory and not (stat.S_ISREG(info.st_mode) or missing):
            reject()
        return info

    def open(self, reference, mode):
        return self.client.open_file(self.path(reference), mode=mode, port=self.port)

    def listing(self, reference):
        result = []
        with self.client.scandir(self.path(reference), port=self.port) as entries:
            for entry in entries:
                if len(result) >= MAX_ENTRIES:
                    reject('PROVIDER_EXPORT_LIMIT')
                result.append((entry.name, entry.stat(follow_symlinks=False)))
        return result

    def rename(self, source, target, replace):
        action = self.client.replace if replace else self.client.rename
        action(self.path(source), self.path(target), port=self.port)

    def remove(self, reference):
        self.client.remove(self.path(reference), port=self.port)

    def close(self):
        self.client.reset_connection_cache(fail_on_error=False)


def identity(info):
    return [str(getattr(info, field, '')) for field in
            ('st_size', 'st_mtime', 'st_mtime_ns', 'st_ino', 'st_ctime_ns')]


def scan(client, reference, limit, destination=None):
    before = client.validate(reference)
    if before.st_size > limit:
        reject('PROVIDER_EXPORT_LIMIT')
    digest, count = hashlib.sha256(), 0
    with client.open(reference, 'rb') as stream:
        while True:
            chunk = stream.read(CHUNK)
            if not chunk:
                break
            count += len(chunk)
            if count > limit:
                reject('PROVIDER_EXPORT_LIMIT')
            digest.update(chunk)
            if destination:
                destination.write(chunk)
    after = client.validate(reference)
    if identity(before) != identity(after) or count != after.st_size:
        reject('PROVIDER_CONFLICT')
    value = digest.hexdigest()
    return {'fingerprint': json.dumps(['network-v1', *identity(after), value], separators=(',', ':')),
            'digest': value, 'size': count}


def execute(request):
    provider, config = request['provider'], request['config']
    client = SFTP(config) if provider == 'sftp' else SMB(config)
    uncertain = False
    temporary = None
    owned = False
    try:
        action, reference, limit = request['action'], request.get('reference', ''), request['limit']
        key(reference, empty=action in ('probe', 'list'))
        if action == 'probe':
            client.validate('', directory=True)
            return {}
        if action == 'list':
            client.validate(reference, directory=True)
            result = []
            for name, info in client.listing(reference):
                key(name)
                if '/' in name:
                    reject()
                if name.startswith('.yourwiki-delivery-') or stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                    continue
                if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                    continue
                if len(result) >= MAX_ENTRIES:
                    reject('PROVIDER_EXPORT_LIMIT')
                item = {'reference': '/'.join(p for p in (reference, name) if p), 'name': name,
                        'kind': 'folder' if stat.S_ISDIR(info.st_mode) else 'file'}
                if item['kind'] == 'file':
                    item['size'] = info.st_size
                result.append(item)
            client.validate(reference, directory=True)
            return result
        if action == 'read':
            with open(request['file'], 'xb') as output:
                return scan(client, reference, limit, output)
        operation = request['operationId']
        if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', operation):
            reject()
        parent = reference.rpartition('/')[0]
        temporary = '/'.join(p for p in (parent, '.yourwiki-delivery-' + operation) if p)
        client.validate(parent, directory=True)
        if action == 'retire':
            try:
                client.validate(temporary)
                client.remove(temporary)
            except FileNotFoundError:
                pass
            return {}

        def baseline():
            if action == 'replace':
                if scan(client, reference, limit)['fingerprint'] != request['baseline']:
                    reject('PROVIDER_CONFLICT')
            elif client.validate(reference, missing=True) is not None:
                reject('PROVIDER_CONFLICT')

        baseline()
        target = request['target']
        digest, count = hashlib.sha256(), 0
        # Exclusive create prevents overwriting another operation's staging file.
        with client.open(temporary, 'wx' if provider == 'sftp' else 'xb') as output:
            owned = True
            with open(request['file'], 'rb') as source:
                while True:
                    chunk = source.read(CHUNK)
                    if not chunk:
                        break
                    count += len(chunk)
                    if count > limit or count > target['size']:
                        reject('PROVIDER_EXPORT_LIMIT')
                    digest.update(chunk)
                    output.write(chunk)
            output.flush()
        if count != target['size'] or digest.hexdigest() != target['digest']:
            reject('PROVIDER_SOURCE_CHANGED')
        # A fresh lease/config check occurs in the parent after staging, before
        # the final baseline read and remote namespace mutation.
        emit({'ready': True})
        if sys.stdin.readline(128).strip() != 'commit':
            reject('PROVIDER_CANCELLED')
        baseline()
        client.validate(parent, directory=True)
        client.validate(temporary)
        uncertain = True
        client.rename(temporary, reference, action == 'replace')
        owned = False
        proof = scan(client, reference, limit)
        if proof['digest'] != target['digest'] or proof['size'] != target['size']:
            reject('PROVIDER_CONFLICT')
        return proof
    except Exception as error:
        # Never expose a transport exception: it may embed credentials or paths.
        code = error.code if isinstance(error, Rejected) else 'ACCESS_DENIED' if isinstance(error, PermissionError) else 'PROVIDER_UNAVAILABLE'
        emit({'error': code, 'outcome': 'unknown' if uncertain else 'not_written'})
        return None
    finally:
        if owned and temporary:
            try:
                client.validate(temporary)
                client.remove(temporary)
            except Exception:
                pass
        client.close()


if __name__ == '__main__':
    try:
        # Config is small; rejecting an excessive control frame avoids unbounded
        # allocations even when invoked outside the TypeScript caller.
        line = sys.stdin.readline(262145)
        if len(line) > 262144:
            reject()
        request = json.loads(line)
        if request.get('provider') not in ('sftp', 'smb') or not isinstance(request.get('limit'), int) or not 0 <= request['limit'] <= 4 * 1024**3:
            reject()
        result = execute(request)
        if result is not None:
            emit({'result': result})
    except Exception as error:
        emit({'error': error.code if isinstance(error, Rejected) else 'PROVIDER_UNAVAILABLE', 'outcome': 'not_written'})
