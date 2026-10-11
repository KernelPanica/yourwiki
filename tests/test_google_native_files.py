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
from wiki.models import Document, Folder, MountPoint, SiteConfiguration
from wiki.services import save_document, Conflict
from wiki.storage import GoogleDrive, StorageError, active_storage, HISTORY_MAX_BYTES
from wiki.file_formats import write_ods, read_ods
from wiki.native import unpack, pack

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
        self.notes = {}
        self.sheet_ids = {}

    def import_file(self, reference, metadata, data):
        ref = reference or f'file-{len(self.files)}'
        previous = self.files.get(ref, {})
        self.files[ref] = {**previous, **metadata, 'id':ref, 'ownedByMe':True, 'shared':False,
                          'owners':[{'permissionId':'account'}], 'version':str(int(previous.get('version', 0))+1), 'data':data}
        return Response({'id':ref, 'version':self.files[ref]['version']})

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        assert '/permissions' not in url, 'Yourwiki must never change Google sharing.'
        if url.startswith('https://sheets.googleapis.com/v4/spreadsheets/'):
            ref = url.rsplit('/',1)[1].removesuffix(':batchUpdate')
            book = unpack(read_ods(self.files[ref]['data']))['data']
            order = book['sheetOrder']
            ids = self.sheet_ids.setdefault(ref,{sid:i for i,sid in enumerate(order)})
            def sheet_key(numeric_id):
                return next(sid for sid in order if ids[sid] == numeric_id)
            if method == 'GET':
                return Response({'sheets':[{'properties':{'sheetId':ids[sid], 'title':book['sheets'][sid]['name'],
                    'gridProperties':{key:book['sheets'][sid][key] for key in ('rowCount','columnCount')}}} for sid in order]})
            assert method == 'POST' and url.endswith(':batchUpdate')
            for request in kwargs['json']['requests']:
                if 'addSheet' in request:
                    props = request['addSheet']['properties']
                    sid = 'native-' + str(props['sheetId'])
                    assert props['sheetId'] not in ids.values()
                    assert props['title'] not in [s['name'] for s in book['sheets'].values()]
                    ids[sid] = props['sheetId']
                    order.append(sid)
                    book['sheets'][sid] = {'name':props['title'],**props['gridProperties'],'cellData':{}}
                    continue
                if 'deleteSheet' in request:
                    sid = sheet_key(request['deleteSheet']['sheetId'])
                    assert len(order)>1
                    order.remove(sid)
                    del book['sheets'][sid]
                    del ids[sid]
                    continue
                if 'updateSheetProperties' in request:
                    props = request['updateSheetProperties']['properties']
                    sid = sheet_key(props['sheetId'])
                    if 'title' in props:
                        assert props['title'] not in [s['name'] for key,s in book['sheets'].items() if key != sid]
                        book['sheets'][sid]['name'] = props['title']
                    if 'index' in props:
                        order.remove(sid)
                        order.insert(props['index'],sid)
                    continue
                if 'appendDimension' in request:
                    continue
                if 'updateCells' not in request:
                    operation, payload = next(iter(request.items()))
                    span = payload.get('range', payload.get('source'))
                    sheet = book['sheets'][sheet_key(span['sheetId'])]
                    is_row = span['dimension'] == 'ROWS'
                    count_key = 'rowCount' if is_row else 'columnCount'
                    size = sheet[count_key]
                    identities = list(range(size))
                    start, end = span['startIndex'], span['endIndex']
                    if operation == 'insertDimension':
                        identities[start:start] = [None]*(end-start)
                    elif operation == 'deleteDimension':
                        del identities[start:end]
                    elif operation == 'moveDimension':
                        block = identities[start:end]
                        del identities[start:end]
                        dest = payload['destinationIndex']
                        if dest > start: dest -= end-start
                        identities[dest:dest] = block
                    else: raise AssertionError(operation)
                    indexes = {old:new for new,old in enumerate(identities) if old is not None}
                    cells = {}
                    for r,row in sheet.get('cellData', {}).items():
                        for c,value in row.items():
                            index = int(r if is_row else c)
                            if index not in indexes: continue
                            nr,nc = (indexes[index],int(c)) if is_row else (int(r),indexes[index])
                            cells.setdefault(str(nr), {})[str(nc)] = value
                    notes = {}
                    for (r,c),note in self.notes.get(ref, {}).items():
                        index = r if is_row else c
                        if index in indexes:
                            notes[(indexes[index],c) if is_row else (r,indexes[index])] = note
                    self.notes[ref] = notes
                    sheet['cellData'] = cells
                    sheet[count_key] = len(identities)
                    continue
                update = request['updateCells']
                start = update['start']
                cells = book['sheets'][sheet_key(start['sheetId'])].setdefault('cellData', {})
                for offset,row in enumerate(update['rows']):
                    for column,value in enumerate(row['values']):
                        cell = cells.setdefault(str(start['rowIndex']+offset), {}).setdefault(str(start['columnIndex']+column), {})
                        assert update['fields'] == 'userEnteredValue', 'Extend mock for format integration tests'
                        cell.pop('v',None); cell.pop('f',None)
                        entered = value.get('userEnteredValue', {})
                        if 'formulaValue' in entered:
                            cell['f'] = entered['formulaValue']
                        elif entered:
                            cell['v'] = next(iter(entered.values()))
            return self.import_file(ref, {}, write_ods(pack('table',book), 'Workbook'))
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
    SiteConfiguration.objects.update_or_create(pk=1,defaults={'revision_history':True})
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


def test_cell_edit_uses_native_batch_and_keeps_id(workspace, google):
    drive, _ = google
    user, team = workspace['admin'], workspace['team']
    doc = save_document(user, 'Budget', 'table', 'Notes', 'Keep,1', team)
    ref = doc.reference
    drive.calls.clear()
    doc = save_document(user, 'Budget', 'table', 'Notes', 'Keep,2', team, doc, doc.revision)
    batches = [call for call in drive.calls if call[1].endswith(':batchUpdate')]
    assert len(batches) == 1
    assert not any(call[2].get('params', {}).get('uploadType') for call in drive.calls)
    assert doc.reference == ref
    cells = unpack(read_ods(active_storage().read(ref)))['data']['sheets']['sheet1']['cellData']
    assert cells['0']['0']['v'] == 'Keep' and cells['0']['1']['v'] == '2'
    # A second save must accept the version returned after the first batch.
    save_document(user, 'Budget', 'table', 'Notes', 'Keep,3', team, doc, doc.revision)


def test_batch_failure_never_falls_back_to_import(workspace, google):
    drive, _ = google
    user, team = workspace['admin'], workspace['team']
    doc = save_document(user, 'Budget', 'table', 'Notes', 'Keep,1', team)
    before = drive.files[doc.reference]['data']
    original = drive.request
    def fail(method, url, **kwargs):
        if url.endswith(':batchUpdate'):
            raise StorageError('Temporary Sheets failure')
        return original(method, url, **kwargs)
    with patch.object(GoogleDrive, 'request', side_effect=fail):
        with pytest.raises(StorageError, match='result is unknown'):
            save_document(user, 'Budget', 'table', 'Notes', 'Keep,2', team, doc, doc.revision)
    assert drive.files[doc.reference]['data'] == before


def test_renaming_native_table_still_uses_batch_without_import(workspace, google):
    drive,_=google
    doc=save_document(workspace['admin'],'Before','table','Notes','A,1',workspace['team'])
    reference=doc.reference
    drive.calls.clear()
    saved=save_document(workspace['admin'],'After','table','Notes','A,2',workspace['team'],doc,doc.revision)
    assert saved.reference==reference
    assert any(call[1].endswith(':batchUpdate') for call in drive.calls)
    assert not any(call[2].get('params',{}).get('uploadType') for call in drive.calls)


def test_batch_rejects_change_after_original_fingerprint(workspace, google):
    drive, _ = google
    user, team = workspace['admin'], workspace['team']
    doc = save_document(user, 'Budget', 'table', 'Notes', 'Keep,1', team)
    original = GoogleDrive.write_table
    def concurrent_edit(adapter, key, data, reference, previous, **kwargs):
        drive.import_file(reference, {}, write_ods('External,9', 'Budget'))
        drive.calls.clear()
        return original(adapter, key, data, reference, previous, **kwargs)
    with patch.object(GoogleDrive, 'write_table', concurrent_edit):
        with pytest.raises(Conflict):
            save_document(user, 'Budget', 'table', 'Notes', 'Keep,2', team, doc, doc.revision)
    assert not any(call[0] in ('POST','PATCH','PUT') for call in drive.calls)


@pytest.mark.parametrize('lost_ack', [False, True])
def test_collaborative_structure_baseline_advances_only_after_provider_save(workspace, google, lost_ack):
    from pycrdt import Doc, Map
    import base64
    from wiki.collaboration import ensure_room, apply_update, flush_room
    from wiki.models import Collaboration
    drive, _ = google
    user, team = workspace['admin'], workspace['team']
    doc = save_document(user, 'Budget', 'table', 'Notes', 'A\nB', team)
    room = ensure_room(doc)
    drive.notes[doc.reference] = {(1,0):'Provider-only note'}
    original_structure = room.saved_structure
    assert original_structure['Sheet 1']['rows'][:2] == ['r0','r1']
    ydoc = Doc(); ydoc.apply_update(bytes(room.state))
    objects = ydoc.get('objects', type=Map)
    objects[json.dumps(['_layout','sheet1','rows','inserted'],separators=(',',':'))] = 0.5
    objects[json.dumps(['sheets','sheet1','cellData','inserted','c0','v'],separators=(',',':'))] = 'new'
    apply_update(user,doc.pk,base64.b64encode(ydoc.get_update()).decode())
    room.refresh_from_db()
    assert room.saved_structure == original_structure
    original = drive.request
    def fail(method,url,**kwargs):
        if url.endswith(':batchUpdate'):
            if lost_ack: original(method,url,**kwargs)
            raise StorageError('offline')
        return original(method,url,**kwargs)
    with patch.object(GoogleDrive, 'request', side_effect=fail):
        with pytest.raises(StorageError): flush_room(doc.pk)
    room.refresh_from_db()
    assert room.saved_structure == original_structure
    flush_room(doc.pk)
    room = Collaboration.objects.get(pk=doc.pk)
    assert room.saved_structure['Sheet 1']['rows'][:3] == ['r0','inserted','r1']
    assert drive.notes[doc.reference] == {(2,0):'Provider-only note'}
    content = unpack(read_ods(active_storage().read(doc.reference)))['data']
    assert [content['sheets']['sheet1']['cellData'][str(i)]['0']['v'] for i in range(3)] == ['A','new','B']
    # A subsequent ordinary edit must not insert the same row a second time.
    objects[json.dumps(['sheets','sheet1','cellData','inserted','c0','v'],separators=(',',':'))] = 'again'
    apply_update(user,doc.pk,base64.b64encode(ydoc.get_update()).decode())
    drive.calls.clear()
    flush_room(doc.pk)
    batches = [c[2]['json']['requests'] for c in drive.calls if c[1].endswith(':batchUpdate')]
    assert len(batches) == 1 and all('updateCells' in req for req in batches[0])


def test_sheet_topology_is_one_native_batch_with_stable_provider_ids(workspace, google):
    drive, _ = google
    def book(items):
        return {'sheetOrder':[sid for sid,name in items],
                'sheets':{sid:{'name':name,'rowCount':2,'columnCount':2,
                               'cellData':{'0':{'0':{'v':sid}}}} for sid,name in items},
                '_axes':{name:{'id':sid,'rows':['r0','r1'],'cols':['c0','c1']} for sid,name in items}}
    previous = book([('a','Alpha'),('b','Beta'),('c','Gone')])
    original = write_ods(pack('table',previous),'Book')
    ref = drive.import_file(None,{'name':'Book','parents':['root'],'mimeType':GoogleDrive.sheet_mime},original).json()['id']
    adapter = active_storage()
    # Export is the authoritative provider snapshot, without YourWiki identities.
    exported = adapter.read(ref)
    target = book([('b','Alpha'),('d','New'),('a','Beta')])
    drive.calls.clear()
    adapter.write_table('Book.ods',write_ods(pack('table',target),'Book'),ref,exported,structure=previous['_axes'])
    batches = [call for call in drive.calls if call[1].endswith(':batchUpdate')]
    assert len(batches) == 1
    assert not any(call[2].get('params',{}).get('uploadType') for call in drive.calls)
    result = unpack(read_ods(drive.files[ref]['data']))['data']
    assert [result['sheets'][sid]['name'] for sid in result['sheetOrder']] == ['Alpha','New','Beta']
    assert [result['sheets'][sid]['cellData']['0']['0']['v'] for sid in result['sheetOrder']] == ['b','d','a']
    ids = drive.sheet_ids[ref]
    assert ids[result['sheetOrder'][0]] == 1
    assert ids[result['sheetOrder'][2]] == 0


def test_collabora_google_sheet_opens_and_saves_same_original(workspace, google, settings):
    from django.test import Client
    from wiki.collabora import eligible, open_session, token_for
    from urllib.parse import urlencode
    drive, _ = google
    settings.COLLABORA_URL = 'https://office.example.test/collabora'
    settings.COLLABORA_WOPI_URL = 'https://yourwiki.example.test'
    doc = save_document(workspace['admin'], 'Office sheet', 'table', 'Notes', 'Name,Value\nKeep,1', workspace['team'])
    reference, original_url = doc.reference, doc.original_url
    assert eligible(doc)
    client = Client(); client.force_login(workspace['admin'])
    assert client.get(f'/documents/{doc.pk}/live/').url.endswith('/office/')
    session = open_session(doc, workspace['admin'])
    path = f'/wopi/files/{session.pk}/contents?' + urlencode({'access_token':token_for(session,workspace['admin'])})
    assert client.get(path).status_code == 200
    data = write_ods('Name,Value\nKeep,99', 'Office sheet')
    drive.calls.clear()
    result = client.post(path, data, content_type='application/octet-stream', HTTP_X_WOPI_OVERRIDE='PUT')
    assert result.status_code == 200, result.content
    doc.refresh_from_db()
    assert doc.reference == reference and doc.original_url == original_url
    assert drive.files[reference]['mimeType'] == GoogleDrive.sheet_mime
    cells = unpack(read_ods(active_storage().read(reference)))['data']['sheets']['sheet1']['cellData']
    assert cells['1']['0']['v'] == 'Keep' and cells['1']['1']['v'] == '99'
    assert any(call[0] == 'PATCH' and call[2].get('params',{}).get('uploadType') == 'multipart' for call in drive.calls)
    assert client.get(path).status_code == 200
    from wiki.models import OfficeSession
    assert not OfficeSession.objects.get(pk=session.pk).pending


def test_collabora_uncertain_google_import_keeps_recovery_without_second_import(workspace, google, settings):
    from django.test import Client
    from wiki.collabora import open_session, token_for
    from wiki.models import OfficeSession
    from urllib.parse import urlencode
    drive, _ = google
    settings.COLLABORA_URL = 'https://office.example.test/collabora'
    doc = save_document(workspace['admin'], 'Office retry', 'table', 'Notes', 'Name,Value\nKeep,1', workspace['team'])
    session = open_session(doc, workspace['admin'])
    path = f'/wopi/files/{session.pk}/contents?' + urlencode({'access_token':token_for(session,workspace['admin'])})
    data = write_ods('Name,Value\nKeep,99', 'Office retry')
    imports = []
    def timeout_after_commit(method, endpoint, **kwargs):
        response = drive.request(method, endpoint, **kwargs)
        if method == 'PATCH' and kwargs.get('params',{}).get('uploadType') == 'multipart':
            imports.append(endpoint)
            raise StorageError('Timeout after remote commit')
        return response
    with patch.object(GoogleDrive,'request',side_effect=timeout_after_commit):
        client = Client()
        first = client.post(path,data,content_type='application/octet-stream',HTTP_X_WOPI_OVERRIDE='PUT')
        assert first.status_code == 503
        second = client.post(path,data,content_type='application/octet-stream',HTTP_X_WOPI_OVERRIDE='PUT')
        assert second.status_code == 409
    assert len(imports) == 1
    assert OfficeSession.objects.get(pk=session.pk).pending == data
    client.force_login(workspace['admin'])
    assert client.get(f'/documents/{doc.pk}/office/recovery/').content == data


def test_office_import_rechecks_native_version_before_dispatch(workspace, google):
    from wiki.storage import mount_adapter
    drive, mount = google
    doc = save_document(workspace['admin'], 'Office race', 'table', 'Notes', 'Name,Value\nKeep,1', workspace['team'])
    _, ref = active_storage().reference(doc.reference)
    adapter = mount_adapter(mount)
    before = adapter.read(ref)
    original = drive.files[ref]['data']
    drive.files[ref]['version'] = str(int(drive.files[ref]['version']) + 1)
    drive.calls.clear()
    with pytest.raises(Conflict):
        adapter.write('Office race.ods', write_ods('Name,Value\nKeep,99', 'Office race'), ref)
    assert drive.files[ref]['data'] == original
    assert not any(call[2].get('params',{}).get('uploadType') for call in drive.calls)
