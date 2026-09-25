"""Docker-enabled CI acceptance runner. Uses isolated, disposable Compose projects."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import requests
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))

def run(*command,**kwargs):
    return subprocess.run(command,cwd=ROOT,check=True,**kwargs)

def ready(url):
    for _ in range(60):
        try:
            if requests.get(url+'/health/',timeout=2).status_code==200:return
        except requests.RequestException:pass
        time.sleep(1)
    raise RuntimeError('Container did not become ready.')

def main():
    suffix=secrets.token_hex(4)
    app=['docker','compose','-p','yourwiki-check-'+suffix,'-f','compose.yaml']
    fixtures=['docker','compose','-p','yourwiki-fixtures-'+suffix,'-f','compose.storage-test.yaml']
    env={**os.environ,'YOURWIKI_PORT':'13000'}
    with tempfile.TemporaryDirectory(prefix='yourwiki-ci-') as directory:
        root=Path(directory)
        password=secrets.token_urlsafe(24)
        setup=root/'setup.json'
        setup.write_text(json.dumps({'public_url':'http://localhost:13000','admin':{'username':'owner','display_name':'Owner','password':password},'storage':{'provider':'local','root':'/documents'}}))
        # Ephemeral test file must be readable by the non-root container UID.
        root.chmod(0o755);setup.chmod(0o644)
        try:
            run(*app,'build',env=env)
            run(*app,'run','--rm','-T','-v',str(setup)+':/run/setup.json:ro','setup','--allow-http','--config','/run/setup.json',env=env)
            run(*app,'up','-d','web',env=env)
            base='http://localhost:13000';ready(base)
            response=requests.get(base+'/',allow_redirects=False,timeout=10)
            assert response.status_code==500 and 'Location' not in response.headers
            session=requests.Session();session.get(base+'/login/',timeout=10)
            response=session.post(base+'/login/',data={'username':'owner','password':password,'csrfmiddlewaretoken':session.cookies['csrftoken']},headers={'Referer':base+'/login/'},timeout=10)
            assert response.status_code==200
            response=session.post(base+'/api/docs',json={'title':'Persist me','content':'# Stored in Docker','group':'team'},headers={'X-CSRFToken':session.cookies['csrftoken']},timeout=10)
            assert response.status_code==201,response.status_code
            id=response.json()['id']
            run(*app,'restart','web',env=env);ready(base)
            assert session.get(base+'/api/docs/'+id,timeout=10).json()['content']=='# Stored in Docker'
            run(*app,'exec','-T','web','python','manage.py','backup','/data/ci-backup.sqlite3',env=env)
            run(*fixtures,'up','-d')
            host_key=''
            for _ in range(30):
                result=subprocess.run([*fixtures,'exec','-T','sftp','cat','/etc/ssh/ssh_host_ed25519_key.pub'],capture_output=True,text=True)
                if result.returncode==0:host_key=' '.join(result.stdout.split()[:2]);break
                time.sleep(1)
            if not host_key:raise RuntimeError('SFTP fixture host key unavailable.')
            config=root/'storage.json'
            config.write_text(json.dumps({'sftp':{'provider':'sftp','host':'127.0.0.1','port':2222,'root':'/upload','username':'wiki','password':'IntegrationPassword123','host_key':host_key},'smb':{'provider':'smb','host':'127.0.0.1','port':1445,'share':'docs','root':'','username':'wiki','password':'IntegrationPassword123'}}))
            config.chmod(0o600)
            from wiki.storage import ADAPTERS,SafeAdapter
            for c in json.loads(config.read_text()).values():
                for attempt in range(30):
                    try:SafeAdapter(ADAPTERS[c['provider']](c)).probe();break
                    except Exception:
                        if attempt==29:raise
                        time.sleep(1)
            print('Docker setup, persistence, SQLite backup, SMB and SFTP checks passed.')
        finally:
            subprocess.run([*app,'down','-v','--remove-orphans'],env=env,cwd=ROOT)
            subprocess.run([*fixtures,'down','-v','--remove-orphans'],cwd=ROOT)

if __name__=='__main__':main()
