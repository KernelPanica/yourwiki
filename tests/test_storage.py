import base64
import contextlib
import io
import json
from pathlib import Path
from unittest.mock import Mock
import pytest
import requests
from wiki.storage import ADAPTERS,GoogleDrive,OneDrive,GitHub,Local,SFTP,SMB,HTTP,SafeAdapter,StorageError,safe_key,MAX_BYTES

class Reply:
    def __init__(self,data=None,content=b'',status_code=200):
        self.data=data;self.content=content;self.status_code=status_code
    def json(self):return self.data
    def __enter__(self):return self
    def __exit__(self,*a):pass
    def iter_content(self,n):yield self.content

@pytest.mark.parametrize('provider',['google','onedrive','github'])
def test_cloud_crud_contract(provider):
    config={'provider':provider,'root':'root','client_id':'client','client_secret':'secret','refresh_token':'refresh','token':'token','repository':'owner/repo','branch':'main'}
    adapter=ADAPTERS[provider](config)
    files={};calls=[]
    def request(method,url,**kwargs):
        calls.append((method,url,kwargs))
        if url.endswith('/token'):return Reply({'access_token':'access','refresh_token':'rotated'})
        if provider=='google':
            if method=='POST':
                assert kwargs['params']['uploadType']=='multipart'
                raw=kwargs['data'];boundary=kwargs['headers']['Content-Type'].split('boundary=')[1].encode()
                data=raw.split(b'Content-Type: application/octet-stream\r\n\r\n')[1].split(b'\r\n--'+boundary)[0]
                files['id']=data;return Reply({'id':'id'})
            if method=='PATCH':files['id']=kwargs['data'];return Reply()
            if method=='GET':assert kwargs['params']['alt']=='media';return Reply(content=files['id'])
            if method=='DELETE':files.pop('id');return Reply()
        if provider=='onedrive':
            if method=='PUT':files['id']=kwargs['data'];return Reply({'id':'id'})
            if method=='GET':return Reply(content=files['id'])
            if method=='DELETE':files.pop('id');return Reply()
        if provider=='github':
            if method=='PUT':
                body=kwargs['json']
                assert body['branch']=='main'
                if files:assert body['sha']=='sha'
                files['id']=base64.b64decode(body['content']);return Reply({'content':{'sha':'sha'}})
            if method=='GET':
                assert kwargs['params']['ref']=='main'
                return Reply(content=files['id']) if kwargs['headers']['Accept']=='application/vnd.github.raw+json' else Reply({'sha':'sha'})
            if method=='DELETE':assert kwargs['json']['sha']=='sha';files.pop('id');return Reply()
        raise AssertionError((method,url))
    adapter.request=request
    adapter.probe()
    assert not files
    assert any(c[0]=='DELETE' for c in calls)
    if provider!='github':assert config['refresh_token']=='rotated'

class MemoryFile(io.BytesIO):
    def __init__(self,files,path,mode):
        self.files,self.path,self.mode=files,path,mode
        super().__init__(b'' if 'w' in mode else files.get(path,b''))
    def close(self):
        if 'w' in self.mode and not self.closed:self.files[self.path]=self.getvalue()
        super().close()

@pytest.mark.parametrize('provider',['sftp','smb'])
def test_network_filesystem_contract(provider):
    config={'provider':provider,'root':'/root' if provider=='sftp' else 'root','host':'server','share':'share','username':'user','password':'secret'}
    adapter=ADAPTERS[provider](config)
    files={}
    fake=Mock()
    fake.open.side_effect=lambda path,mode:MemoryFile(files,path,mode)
    fake.open_file.side_effect=lambda path,mode,**kwargs:MemoryFile(files,path,mode)
    fake.remove.side_effect=lambda path,**kwargs:files.pop(path,None)
    if provider=='sftp':
        @contextlib.contextmanager
        def client():yield fake
        adapter.client=client
    else:adapter.client=lambda:fake
    adapter.probe()
    assert not files
    if provider == 'sftp':
        fake.mkdir.return_value=None
        adapter.ensure_dir('Projects/Notes')
        assert fake.mkdir.call_count==2
    else:
        adapter.ensure_dir('Projects/Notes')
        fake.makedirs.assert_called_once()


def test_local_storage_and_traversal(tmp_path):
    adapter=Local({'root':str(tmp_path)})
    adapter.probe()
    assert not list(tmp_path.iterdir())
    for path in ('../secret','/etc/passwd','a/../b','a\\b','a//b'):
        with pytest.raises(StorageError):adapter.read(path)
    outside=tmp_path.parent/'outside';outside.mkdir(exist_ok=True)
    (tmp_path/'link').symlink_to(outside,target_is_directory=True)
    with pytest.raises(StorageError):adapter.write('link/file',b'data')
    with pytest.raises(StorageError):adapter.write('big',b'x'*(MAX_BYTES+1))


def test_remote_directory_paths_use_provider_folders():
    google=GoogleDrive({'root':'root'})
    google.headers=lambda: {}
    calls=[]
    def google_request(method,url,**kw):
        calls.append((method,url,kw))
        if method=='GET':return Reply({'files':[]})
        if kw.get('json') and kw['json'].get('mimeType')=='application/vnd.google-apps.folder':
            return Reply({'id':'folder-'+kw['json']['name']})
        return Reply({'id':'file'})
    google.request=google_request
    google.ensure_dir('Projects/Notes')
    ref=google.write('Projects/Notes/example.md',b'test')
    assert ref=='file'
    uploaded=[kw['data'] for method,url,kw in calls if kw.get('params',{}).get('uploadType')=='multipart'][0]
    assert b'"name": "example.md"' in uploaded
    assert b'"parents": ["folder-Notes"]' in uploaded

    onedrive=OneDrive({'root':'root'})
    onedrive.headers=lambda: {}
    urls=[]
    def onedrive_request(method,url,**kw):
        urls.append((method,url))
        return Reply({'id':'folder-'+kw['json']['name']} if method=='POST' else {'id':'file'},status_code=404 if method=='GET' else 200)
    onedrive.request=onedrive_request
    onedrive.ensure_dir('Projects/Notes')
    onedrive.write('Projects/Notes/example.md',b'test')
    assert ('POST',onedrive.base+'/items/folder-Projects/children') in urls
    assert ('PUT',onedrive.base+'/items/root:/Projects/Notes/example.md:/content') in urls


def test_http_errors_do_not_leak_provider_details(monkeypatch):
    def fail(*args,**kwargs):raise requests.HTTPError('SECRET-TOKEN https://provider/private')
    monkeypatch.setattr(requests,'request',fail)
    with pytest.raises(StorageError) as error:HTTP({}).request('GET','https://example.test')
    assert 'SECRET' not in str(error.value)
    broken=Mock();broken.read.side_effect=OSError('secret path')
    with pytest.raises(StorageError) as error:SafeAdapter(broken).read('x')
    assert 'secret path' not in str(error.value)
