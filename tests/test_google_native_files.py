"""Drive API contracts, including import/export of the SAME Google object."""
import hashlib
import io
import json
import re
import zipfile
from unittest.mock import patch
import pytest
from django.core.management import call_command
from wiki.crypto import encrypt
from wiki.models import Document, Folder, MountPoint
from wiki.services import save_document, Conflict
from wiki.storage import GoogleDrive, StorageError, active_storage, HISTORY_MAX_BYTES
from wiki.file_formats import write_ods, read_ods
from wiki.native import unpack

pytestmark = pytest.mark.django_db


class Response:
    def __init__(self, value=None, data=b'', headers=None):
        self.value, self.data, self.headers = value, data, headers or {}
    def json(self): return self.value
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def iter_content(self, size): yield self.data


class Drive:
    def __init__(self):
        self.files = {'root': {'id':'root', 'name':'Root', 'mimeType':'application/vnd.google-apps.folder',
                              'ownedByMe':True, 'shared':False, 'owners':[{'permissionId':'account'}], 'version':'1'}}
        self.calls = []
        self.uploads = {}

    def import_file(self, reference, metadata, data):
        ref = reference or f'file-{len(self.files)}'
        previous = self.files.get(ref, {})
        self.files[ref] = {**previous, **metadata, 'id':ref, 'ownedByMe':True, 'shared':False,
                          'owners':[{'permissionId':'account'}], 'version':str(int(previous.get('version', 0))+1), 'data':data}
        return Response({'id':ref, 'version':self.files[ref]['version']})

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        assert '/permissions' not in url, 'Yourwiki must never change Google sharing.'
        params = kwargs.get('params', {})
        ref = url.split('/files/', 1)[1].split('/')[0] if '/files/' in url else None
        if method == 'PUT' and url in self.uploads:
            reference, metadata = self.uploads[url]
            return self.import_file(reference, metadata, kwargs['data'])
        if params.get('uploadType') == 'resumable':
            session = 'https://www.googleapis.com/upload/session/' + str(len(self.uploads))
            self.uploads[session] = (ref, kwargs['json'])
            return Response(headers={'Location':session})
        if params.get('uploadType') == 'multipart':
            boundary = kwargs['headers']['Content-Type'].split('boundary=')[1].encode()
            parts = kwargs['data'].split(b'--' + boundary)
            metadata = json.loads(parts[1].split(b'\r\n\r\n', 1)[1])
            data = parts[2].split(b'\r\n\r\n', 1)[1].removesuffix(b'\r\n')
            return self.import_file(ref, metadata, data)
        if method == 'GET' and url.endswith('/files'):
            parent = re.search(r"'([^']+)' in parents", params['q'])[1]
            name = re.search(r"name = '([^']+)'", params['q'])
            items = [item for item in self.files.values() if parent in item.get('parents', [])
                     and (not name or item['name'] == name[1])]
            if 'mimeType =' in params['q']:
                items = [item for item in items if item['mimeType'] == 'application/vnd.google-apps.folder']
            return Response({'files':items})
        if method == 'GET' and url.endswith('/export'):
            assert params['mimeType'] == GoogleDrive.ods_mime
            # Google exports its native visible content, not Yourwiki's ZIP metadata.
            result = io.BytesIO()
            with zipfile.ZipFile(io.BytesIO(self.files[ref]['data'])) as source, zipfile.ZipFile(result, 'w') as target:
                for name in source.namelist():
                    if name != 'meta.xml':
                        target.writestr(name, source.read(name))
            return Response(data=result.getvalue())
        if method == 'GET' and params.get('alt') == 'media':
            return Response(data=self.files[ref]['data'])
        if method == 'GET': return Response(self.files[ref].copy())
        if method == 'POST':
            return self.import_file(None, kwargs['json'], b'')
        if method == 'PATCH':
            if params.get('uploadType') == 'media':
                return self.import_file(ref, {}, kwargs['data'])
            item = self.files[ref]
            item.update(kwargs['json'])
            if 'addParents' in params: item['parents'] = [params['addParents']]
            item['version'] = str(int(item['version'])+1)
            return Response({'id':ref})
        if method == 'DELETE':
            self.files.pop(ref, None)
            return Response()
        raise AssertionError((method,url,kwargs))


@pytest.fixture
def google(workspace):
    drive = Drive()
    mount = MountPoint.objects.create(path='/', provider='google', encrypted_config=encrypt({
        'provider':'google', 'root':'root', 'client_id':'client', 'client_secret':'secret', 'refresh_token':'refresh'}))
    with patch.object(GoogleDrive, 'headers', return_value={'Authorization':'Bearer server-only'}), \
         patch.object(GoogleDrive, 'request', side_effect=drive.request):
        yield drive, mount


def test_native_sheet_id_url_history_and_external_conflict(workspace, google):
    drive, mount = google
    user, team = workspace['admin'], workspace['team']
    doc = save_document(user, 'Budget', 'table', 'Notes', 'Name,Total\nUnicode Привет,42', team)
    ref = doc.reference
    assert drive.files[ref]['mimeType'] == GoogleDrive.sheet_mime
    assert doc.original_url == f'https://docs.google.com/spreadsheets/d/{ref}/edit'
    assert not doc.history_reference and not any(i['name'].endswith('.json') for i in drive.files.values())
    cells = unpack(read_ods(active_storage().read(ref)))['data']['sheets']['sheet1']['cellData']
    assert cells['1']['0']['v'] == 'Unicode Привет'
    doc = save_document(user, 'Budget', 'table', 'Notes', 'Name,Total\nUpdated,99', team, doc, doc.revision)
    assert doc.reference == ref
    doc.revision_history = True
    doc.save()
    doc = save_document(user, 'Budget', 'table', 'Notes', 'Name,Total\nThird,100', team, doc, doc.revision)
    assert drive.files[doc.history_reference]['name'] == 'Budget.ods.json'
    history = json.loads(active_storage().read(doc.history_reference, limit=HISTORY_MAX_BYTES))
    assert len(history['entries']) == 1
    before = write_ods('External,123', 'Budget')
    drive.import_file(ref, {}, before)
    with pytest.raises(Conflict):
        save_document(user, 'Budget', 'table', 'Notes', 'Stale,0', team, doc, doc.revision)
    assert drive.files[ref]['data'] == before


@pytest.mark.parametrize('bad', [{'shared':True}, {'ownedByMe':False}, {'driveId':'shared-drive'}])
def test_private_account_required_without_rewriting_provider_acl(workspace, google, bad):
    drive, _ = google
    drive.files['root'].update(bad)
    with pytest.raises(StorageError, match='private'):
        save_document(workspace['admin'], 'Unsafe', 'table', 'Notes', '', workspace['team'])
    assert len(drive.files) == 1
    assert not Document.objects.exists()
    assert not any(method in ('POST','PATCH','PUT','DELETE') for method,_,_ in drive.calls)


def test_native_google_scan_and_restart_restore_without_snapshot(workspace, google):
    drive, _ = google
    drive.import_file(None, {'name':'Existing', 'parents':['root'], 'mimeType':GoogleDrive.sheet_mime},
                      write_ods('City,Total\nМосква,25', 'Existing'))
    call_command('scan_storage')
    doc = Document.objects.get()
    assert doc.kind == 'table' and doc.file_format == 'ods' and doc.title == 'Existing'
    from wiki.collaboration import ensure_room, current_content
    ensure_room(doc).delete()
    from wiki import storage
    storage._mount_cache.clear()
    content = unpack(current_content(Document.objects.get(pk=doc.pk)))['data']
    assert content['sheets']['sheet1']['cellData']['1']['0']['v'] == 'Москва'


def test_google_native_cross_mount_move_keeps_identity(workspace, google):
    drive, _ = google
    remote = drive.import_file(None, {'name':'Other', 'mimeType':'application/vnd.google-apps.folder', 'parents':['root']}, b'').json()['id']
    destination = Folder.objects.create(name='Other', owner=workspace['admin'], group=workspace['team'])
    target_mount = MountPoint.objects.create(path='/Other', folder=destination, provider='google',
        encrypted_config=encrypt({'provider':'google','root':remote}))
    doc = save_document(workspace['admin'], 'Sheet', 'table', 'Notes', 'Value\n42', workspace['team'])
    ref = doc.reference
    from wiki.folders import move_item
    before = len([c for c in drive.calls if c[2].get('params', {}).get('uploadType')])
    move_item(workspace['admin'], doc, destination)
    assert doc.reference == f'mount:{target_mount.pk}:{ref}'
    assert drive.files[ref]['parents'] == [remote]
    assert len([c for c in drive.calls if c[2].get('params', {}).get('uploadType')]) == before
    doc = save_document(workspace['admin'], 'Sheet', 'table', 'Notes', 'Value\n43', workspace['team'], doc, doc.revision)
    assert doc.reference.endswith(':' + ref)


def test_large_google_history_uses_resumable_upload(workspace, google):
    drive, _ = google
    adapter = active_storage()
    data = b'x' * (6*1024*1024)
    ref = adapter.write('history.bin.json', data, limit=HISTORY_MAX_BYTES)
    assert adapter.read(ref, limit=HISTORY_MAX_BYTES) == data
    assert len(drive.uploads) == 1
