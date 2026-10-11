import hashlib
from urllib.parse import unquote
from pathlib import Path
import pytest
from django.contrib.staticfiles import finders

@pytest.mark.django_db
def test_collabora_font_catalogue_is_public_and_assets_are_real(client, workspace, settings, tmp_path):
    settings.GOOGLE_FONTS_DIR = tmp_path
    settings.COLLABORA_WOPI_URL = 'https://wiki.example'
    response = client.get('/office/fonts.json')
    assert response.status_code == 200
    data = response.json()
    assert data['kind'] == 'fontconfiguration'
    assert len(data['fonts']) >= 12
    families = set()
    for item in data['fonts']:
        assert item['uri'].startswith('https://wiki.example/static/wiki/fonts/office/')
        path = unquote(item['uri'].split('/static/', 1)[1])
        binary = Path(finders.find(path)).read_bytes()
        assert binary[:4] in (b'\x00\x01\x00\x00', b'OTTO')
        assert hashlib.sha256(binary).hexdigest() == item['stamp']
        families.add(path.split('/')[-2])
        assert Path(finders.find('/'.join(path.split('/')[:-1])+'/OFL.txt')).exists()
    assert {'tinos','oswald','anton','arimo','cousine','roboto','opensans'} <= families
    assert client.post('/office/fonts.json').status_code == 405


def _glyphs(data):
    """Read Unicode cmap entries directly so the check needs no system fonts."""
    import struct
    u16 = lambda offset: struct.unpack_from('>H', data, offset)[0]
    u32 = lambda offset: struct.unpack_from('>I', data, offset)[0]
    cmap = next(u32(offset+8) for offset in range(12, 12+16*u16(4), 16)
                if data[offset:offset+4] == b'cmap')
    result = set()
    for record in range(cmap+4, cmap+4+8*u16(cmap+2), 8):
        platform, encoding = u16(record), u16(record+2)
        if platform != 0 and (platform != 3 or encoding not in (1, 10)):
            continue
        table = cmap + u32(record+4)
        format = u16(table)
        if format == 12:
            for group in range(table+16, table+16+12*u32(table+12), 12):
                start, end, glyph = struct.unpack_from('>III', data, group)
                result.update(range(start+(glyph == 0), end+1))
        elif format == 4:
            count = u16(table+6)//2
            ends = table+14
            starts = ends+2*count+2
            deltas = starts+2*count
            offsets = deltas+2*count
            for index in range(count):
                for code in range(u16(starts+2*index), u16(ends+2*index)+1):
                    delta, relative = u16(deltas+2*index), u16(offsets+2*index)
                    if relative:
                        glyph = u16(offsets+2*index+relative+2*(code-u16(starts+2*index)))
                        glyph = (glyph+delta)&0xffff if glyph else 0
                    else:
                        glyph = (code+delta)&0xffff
                    if glyph:
                        result.add(code)
    return result


def test_every_bundled_font_contains_complete_russian_alphabet():
    import json
    manifest = json.loads(Path(finders.find('wiki/fonts/office/manifest.json')).read_text())
    required = set(range(ord('А'), ord('я')+1)) | {ord('Ё'), ord('ё')}
    for row in manifest:
        data = Path(finders.find(row['path'])).read_bytes()
        assert required <= _glyphs(data), row['path']


@pytest.mark.django_db
def test_installed_google_catalogue_serves_only_registered_open_fonts(client, workspace, settings, tmp_path):
    import json
    settings.GOOGLE_FONTS_DIR = tmp_path
    target = tmp_path/'google/ofl/test/Test.ttf'
    target.parent.mkdir(parents=True)
    data = b'\x00\x01\x00\x00test-font'
    target.write_bytes(data)
    (target.parent/'OFL.txt').write_text('Test open licence')
    stamp = hashlib.sha256(data).hexdigest()
    (tmp_path/'google-fonts.json').write_text(json.dumps({'families': [{'name': 'Test Font', 'fonts': [{'path': 'google/ofl/test/Test.ttf', 'stamp': stamp}], 'subsets': ['latin'], 'licenses': ['google/ofl/test/OFL.txt']}]}))
    client.force_login(workspace['admin'])
    response = client.get('/office/google-fonts.json')
    assert response.status_code == 200
    assert response.json()['families'][0]['name'] == 'Test Font'
    url = response.json()['families'][0]['fonts'][0]['url']
    client.logout()
    font_response=client.get(url)
    assert b''.join(font_response.streaming_content) == data
    assert 'license' in font_response['Link']
    assert b''.join(client.get(url+'?license=1').streaming_content)==b'Test open licence'
    configuration=client.get('/office/fonts.json')
    assert any(item['uri'].endswith(url) for item in configuration.json()['fonts'])
    assert client.get('/office/fonts.json',HTTP_IF_NONE_MATCH=configuration['ETag']).status_code==304
    assert client.get('/office/google-fonts/not-a-real-font/').status_code == 404
    assert client.get('/office/google-fonts/Impact.TTF/').status_code == 404


def test_google_font_catalogue_has_every_declared_upstream_font():
    import json,re
    root=Path(__file__).resolve().parents[1]/'instance/office-fonts'
    if not (root/'google-fonts.json').is_file():
        pytest.skip('Google Fonts catalogue not installed locally')
    catalogue=json.loads((root/'google-fonts.json').read_text())
    assert len(catalogue['families'])>2000
    for family in catalogue['families']:
        parent=(root/family['fonts'][0]['path']).parent
        while not (parent/'METADATA.pb').is_file():parent=parent.parent
        declared=set(re.findall(r'filename:\s*"([^"]+)"',(parent/'METADATA.pb').read_text()))
        assert declared <= {font['filename'] for font in family['fonts']},family['name']
        assert all((root/font['path']).is_file() for font in family['fonts'])
        assert family['licenses']
