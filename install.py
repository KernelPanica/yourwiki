#!/usr/bin/env python3
"""Interactive Docker installer. Python only; secrets are never CLI arguments."""
import argparse
import base64
import contextlib
import fcntl
import getpass
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import secrets
import threading
import time
import traceback
from urllib.parse import parse_qs, quote, urlencode, urlparse

import requests
from cryptography.fernet import Fernet


def atomic_secret(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp-' + secrets.token_hex(8))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def ask(label, default='', secret=False):
    value = getpass.getpass(label + ': ') if secret else input(label + (f' [{default}]' if default else '') + ': ')
    return value.strip() or default


def authorize(config, public_url):
    """One-time, state-bound callback server. No public setup UI or credentials."""
    provider=config['provider']
    state=secrets.token_urlsafe(32)
    verifier=secrets.token_urlsafe(64)
    redirect_uri=public_url+'/setup/oauth/callback'
    result={}
    done=threading.Event()
    class Callback(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Callback URL contains the authorization code.
        def do_GET(self):
            parsed=urlparse(self.path)
            params=parse_qs(parsed.query)
            valid=parsed.path=='/setup/oauth/callback' and secrets.compare_digest(params.get('state',[''])[0],state) and not done.is_set()
            if valid and (params.get('code') or params.get('error')):
                result.update(params)
                body=b'Authorization received. Return to the installation terminal.'
                self.send_response(200)
            else:
                body=b'Server error'
                self.send_response(500)
            self.send_header('Content-Type','text/plain')
            self.send_header('Cache-Control','no-store')
            self.send_header('Referrer-Policy','no-referrer')
            self.end_headers(); self.wfile.write(body)
            if valid: done.set()
    server=HTTPServer(('0.0.0.0',int(os.environ.get('SETUP_PORT','8000'))),Callback)
    server.timeout=1
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    auth_endpoint='https://accounts.google.com/o/oauth2/v2/auth' if provider=='google' else f"https://login.microsoftonline.com/{quote(config.get('tenant','common'),safe='')}/oauth2/v2.0/authorize"
    token_endpoint='https://oauth2.googleapis.com/token' if provider=='google' else f"https://login.microsoftonline.com/{quote(config.get('tenant','common'),safe='')}/oauth2/v2.0/token"
    scope='https://www.googleapis.com/auth/drive.file' if provider=='google' else 'offline_access Files.ReadWrite'
    params={'client_id':config['client_id'],'redirect_uri':redirect_uri,'response_type':'code','scope':scope,'state':state,'code_challenge':base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode(),'code_challenge_method':'S256'}
    if provider=='google': params.update(access_type='offline',prompt='consent')
    print('\nRegister this exact redirect URI in your OAuth application:\n'+redirect_uri)
    print('Your HTTPS proxy must forward to this setup container. Open this URL:\n'+auth_endpoint+'?'+urlencode(params),flush=True)
    try:
        if not done.wait(600): raise ValueError('Authorization timed out. Run setup again to resume.')
    finally:
        server.shutdown(); server.server_close(); thread.join()
    if 'code' not in result: raise ValueError('Authorization was not granted.')
    try:
        response=requests.post(token_endpoint,data={'client_id':config['client_id'],'client_secret':config['client_secret'],'redirect_uri':redirect_uri,'grant_type':'authorization_code','code':result['code'][0],'code_verifier':verifier},timeout=30)
        response.raise_for_status(); tokens=response.json()
    except requests.RequestException:
        raise ValueError('Token exchange failed. Check your OAuth application settings.') from None
    if not tokens.get('refresh_token'): raise ValueError('No refresh token was returned. Grant offline access and retry.')
    config['refresh_token']=tokens['refresh_token']


def storage_config(provider, old=None):
    c=dict(old or {})
    c['provider']=provider
    if provider=='local':
        c['root']=c.get('root') or os.environ.get('YOURWIKI_DOCUMENTS',str(Path(os.environ.get('YOURWIKI_DATA','instance'))/'documents'))
    elif provider in ('google','onedrive'):
        c['client_id']=ask('OAuth client ID',c.get('client_id',''))
        c['client_secret']=ask('OAuth client secret',secret=True)
        if provider=='onedrive': c['tenant']=ask('Tenant (common supports personal and organizational accounts)',c.get('tenant','common'))
    elif provider=='github':
        if not old:
            c['repository']=ask('GitHub repository (owner/repo)')
            c['branch']=ask('Existing writable branch','main')
            c['root']=ask('Dedicated path prefix','yourwiki')
        c['token']=ask('Fine-grained GitHub token (Contents read/write)',secret=True)
    elif provider=='smb':
        if not old:
            c.update(host=ask('SMB server'),port=int(ask('Port','445')),share=ask('Share'),root=ask('Existing directory within the share'))
        c.update(username=ask('Username',c.get('username','')),domain=ask('Domain (optional)',c.get('domain','')),password=ask('Password',secret=True))
    elif provider=='sftp':
        if not old:
            c.update(host=ask('SFTP host'),port=int(ask('Port','22')),root=ask('Existing absolute remote directory'),host_key=ask('Verified host key (type and base64 key, from your server administrator)'))
        c['username']=ask('Username',c.get('username',''))
        key_path=ask('Private key file inside the container (blank for password)')
        c.pop('private_key',None);c.pop('password',None)
        if key_path:
            c['private_key']=Path(key_path).read_text()
            c['key_passphrase']=ask('Private key passphrase (optional)',secret=True)
        else: c['password']=ask('Password',secret=True)
    else: raise ValueError('Unsupported storage provider.')
    return c


def validate_config(c):
    provider=c.get('provider')
    fields={'local':['root'],'google':['client_id','client_secret'],'onedrive':['client_id','client_secret'],'github':['repository','branch','token'],'smb':['host','share','username','password'],'sftp':['host','root','username','host_key']}
    if provider not in fields or any(not c.get(k) for k in fields[provider]): raise ValueError('Missing required storage settings.')
    if provider=='github' and len(c['repository'].split('/'))!=2: raise ValueError('Use owner/repository for GitHub.')
    if provider in ('github','smb'):
        root=c.get('root','').replace('\\','/')
        if root.startswith('/') or any(p=='..' for p in root.split('/')): raise ValueError('Use a relative storage directory without parent traversal.')
    if provider=='sftp' and not c['root'].startswith('/'): raise ValueError('Use an absolute SFTP directory.')


def run(args):
    data=Path(os.environ.get('YOURWIKI_DATA','instance')).resolve()
    secrets_dir=Path(os.environ.get('YOURWIKI_SECRETS',data/'secrets')).resolve()
    data.mkdir(parents=True,exist_ok=True);secrets_dir.mkdir(parents=True,exist_ok=True)
    with (data/'setup.lock').open('a') as lock:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: raise ValueError('Another setup process is running.')
        runtime_file=secrets_dir/'runtime.json'
        runtime=json.loads(runtime_file.read_text()) if runtime_file.exists() else {}
        supplied=json.loads(Path(args.config).read_text()) if args.config else None
        public_url=runtime.get('public_url') or (supplied or {}).get('public_url') or ask('Public HTTPS URL (for example https://wiki.example.com)')
        parsed=urlparse(public_url)
        if parsed.scheme not in ('https','http') or not parsed.hostname or parsed.path not in ('','/') or parsed.query or parsed.fragment or parsed.username:
            raise ValueError('Use an origin URL without a path, credentials, query, or fragment.')
        if parsed.scheme!='https' and not args.allow_http: raise ValueError('HTTPS is required. Use --allow-http only for local development.')
        public_url=public_url.rstrip('/')
        runtime.update(public_url=public_url,allowed_hosts=[parsed.hostname,'localhost','127.0.0.1'],django_secret=runtime.get('django_secret') or secrets.token_urlsafe(64))
        atomic_secret(runtime_file,json.dumps(runtime))
        keyfile=secrets_dir/'encryption.key'
        if not keyfile.exists(): atomic_secret(keyfile,Fernet.generate_key().decode())
        os.environ.update(YOURWIKI_DATA=str(data),YOURWIKI_SECRETS=str(secrets_dir),DJANGO_SETTINGS_MODULE='config.settings')
        import django
        django.setup()
        from django.core.management import call_command
        from django.contrib.auth.password_validation import validate_password
        from django.contrib.auth.models import Group
        from django.db import transaction
        from wiki.models import Workspace,User,MountPoint
        from wiki.crypto import encrypt,decrypt
        from wiki.storage import ADAPTERS,SafeAdapter
        call_command('migrate',interactive=False,verbosity=0)
        ws=Workspace.objects.filter(pk=1).first()
        if ws and ws.initialized and not args.reconnect: raise ValueError('Already initialized. Setup will not overwrite the administrator or storage.')
        if args.reconnect and not (ws and ws.initialized): raise ValueError('Initialize the workspace before reconnecting.')
        old=decrypt(ws.encrypted_config) if ws else None
        if args.reconnect:
            c=storage_config(ws.provider,old) if not supplied else {**old,**supplied['storage']}
            for key in ('provider','root','repository','branch','host','port','share','host_key'):
                if key in old and c.get(key)!=old[key]: raise ValueError('Reconnect cannot change the storage root or identity.')
        else:
            admin=(supplied or {}).get('admin') or {'username':ask('First administrator username'),'display_name':ask('Display name'),'password':ask('Password (at least 12 characters)',secret=True)}
            if not supplied and admin['password']!=ask('Confirm password',secret=True): raise ValueError('Passwords do not match.')
            user=User(username=admin['username'],display_name=admin['display_name'],is_superuser=True,is_staff=True,is_active=True)
            validate_password(admin['password'],user);user.set_password(admin['password']);user.full_clean()
            provider=(supplied or {}).get('storage',{}).get('provider') or (ws.provider if ws else ask('Root mount (/): local, google, onedrive, github, smb, sftp','local'))
            c=(supplied or {}).get('storage') or storage_config(provider,old)
        validate_config(c)
        def checkpoint(updated):
            if not args.reconnect:
                Workspace.objects.update_or_create(pk=1,defaults={'provider':updated['provider'],'encrypted_config':encrypt(updated),'initialized':False})
        if c['provider'] in ('google','onedrive'):
            if not supplied or not c.get('refresh_token'): authorize(c,public_url)
            checkpoint(c)
        adapter=SafeAdapter(ADAPTERS[c['provider']](c,checkpoint))
        if c['provider'] in ('google','onedrive') and not c.get('root'):
            adapter.create_root('Yourwiki')
        checkpoint(c)
        print('Checking storage create/read/update/delete access…',flush=True)
        adapter.probe()
        with transaction.atomic():
            existing=Workspace.objects.filter(pk=1,initialized=True).exists()
            if existing and not args.reconnect: raise ValueError('Already initialized.')
            if not args.reconnect:
                user.save()
                group,_=Group.objects.get_or_create(name='team')
                user.groups.add(group)
            Workspace.objects.update_or_create(pk=1,defaults={'provider':c['provider'],'encrypted_config':encrypt(c),'initialized':True})
            MountPoint.objects.update_or_create(path='/', defaults={'provider':c['provider'],'encrypted_config':encrypt(c)})
        print('Root mount reconnected.' if args.reconnect else 'Administrator registered and root mount / connected.')
        print('Start: docker compose up -d web\nSign in: '+public_url+'/login/')


def main():
    parser=argparse.ArgumentParser(description='Initialize Yourwiki administrator and root mount /')
    parser.add_argument('--reconnect',action='store_true')
    parser.add_argument('--config',help='Read unattended setup from a private JSON file (never put secrets in CLI arguments)')
    parser.add_argument('--allow-http',action='store_true',help='Local development only')
    parser.add_argument('--debug',action='store_true',help='Print an unexpected setup traceback; redact it before sharing')
    args=parser.parse_args()
    try: run(args)
    except KeyboardInterrupt:
        print('\nSetup interrupted. Run it again to resume.');return 1
    except Exception as error:
        from django.core.exceptions import ValidationError
        from wiki.storage import StorageError
        if isinstance(error,ValidationError): print('Setup failed: '+'; '.join(error.messages))
        elif isinstance(error,(ValueError,StorageError)): print('Setup failed: '+str(error))
        else:
            print('Setup failed. Check volume permissions, supplied settings, and provider connectivity. No administrator was overwritten.')
            if args.debug:
                traceback.print_exc()
        return 1
    return 0

if __name__=='__main__':
    raise SystemExit(main())
