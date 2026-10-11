#!/usr/bin/env python3
"""Install the pinned Google Fonts repository's freely distributed font catalogue."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import tempfile
import requests


def install(directory, revision=None):
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    if revision is None:
        response = session.get('https://api.github.com/repos/google/fonts/commits/main', timeout=30)
        response.raise_for_status()
        revision = response.json()['sha']
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('Use a full Google Fonts commit SHA.')
    manifest_path = directory/'google-fonts.json'
    if manifest_path.exists():
        old = json.loads(manifest_path.read_text())
        if old.get('revision') == revision and all((directory/font['path']).is_file() for family in old['families'] for font in family['fonts']):
            print(f'Already installed: {len(old["families"])} families at {revision}', flush=True)
            return old
    print(f'Downloading Google Fonts revision {revision} (approximately 2.3 GiB of fonts)…', flush=True)
    response = session.get(f'https://codeload.github.com/google/fonts/tar.gz/{revision}', stream=True, timeout=(30, 120))
    response.raise_for_status()
    families = {}
    count = 0
    with tarfile.open(fileobj=response.raw, mode='r|gz') as archive:
        for member in archive:
            parts = PurePosixPath(member.name).parts
            if not member.isfile() or len(parts) < 4 or parts[1] not in ('ofl', 'apache', 'ufl'):
                continue
            relative = PurePosixPath(*parts[1:])
            if '..' in relative.parts or relative.is_absolute():
                raise ValueError('Invalid upstream archive path.')
            name = relative.name
            is_font = name.lower().endswith(('.ttf', '.otf'))
            if not is_font and name not in ('METADATA.pb', 'OFL.txt', 'LICENSE.txt', 'LICENCE.txt', 'UFL.txt', 'LICENSE'):
                continue
            if member.size > 100*1024*1024:
                raise ValueError('Unexpectedly large upstream file.')
            data = archive.extractfile(member).read()
            if is_font and data[:4] not in (b'\x00\x01\x00\x00', b'OTTO', b'ttcf'):
                raise ValueError('Invalid upstream font.')
            target = directory/'google'/Path(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix+'.tmp')
            temporary.write_bytes(data)
            temporary.replace(target)
            family = families.setdefault('/'.join(parts[1:3]), {'fonts': [], 'licenses': []})
            if name == 'METADATA.pb':
                metadata = data.decode()
                match = re.search(r'^name:\s*"([^"]+)"', metadata, re.M)
                family['name'] = match.group(1) if match else parts[2]
                family['subsets'] = re.findall(r'^subsets:\s*"([^"]+)"', metadata, re.M)
                family['metadata'] = metadata
            elif is_font:
                family['fonts'].append({'path': target.relative_to(directory).as_posix(), 'stamp': hashlib.sha256(data).hexdigest(), 'filename': name})
                count += 1
                if count % 100 == 0:
                    print(f'Installed {count} font files…', flush=True)
            else:
                family['licenses'].append(target.relative_to(directory).as_posix())
    return index_catalogue(directory, revision, families)


def index_catalogue(directory, revision, families):
    manifest_path = directory/'google-fonts.json'
    result = []
    for family in families.values():
        if not family.get('name') or not family['fonts']:
            continue
        metadata = family.pop('metadata', '')
        if not family['licenses']:
            license_type = re.search(r'^license:\s*"([^"]+)"', metadata, re.M)
            license_type = license_type.group(1) if license_type else ''
            source = next((path for path in (directory/'google').rglob('OFL.txt' if license_type=='OFL' else 'LICENSE.txt') if ('SIL OPEN FONT LICENSE' if license_type=='OFL' else 'Apache License') in path.read_text(errors='replace')), None)
            if license_type not in ('OFL','APACHE2') or source is None:
                raise ValueError('Unknown upstream font licence.')
            original = source.read_text()
            marker = 'SIL OPEN FONT LICENSE' if license_type=='OFL' else 'Apache License'
            body = original[original.index(marker):]
            copyrights = re.findall(r'copyright:\s*"([^"]+)"', metadata)
            parent = (directory/family['fonts'][0]['path']).parent
            target = parent/('OFL.txt' if license_type=='OFL' else 'LICENSE.txt')
            target.write_text('\n'.join(dict.fromkeys(copyrights))+'\n\n'+body)
            family['licenses'] = [target.relative_to(directory).as_posix()]
        declared=set(re.findall(r'filename:\s*"([^"]+)"',metadata))
        for font in family['fonts']:
            font['declared']=font['filename'] in declared
            block = next((block for block in re.findall(r'fonts\s*\{([^{}]*)\}', metadata, re.S) if f'filename: "{font["filename"]}"' in block), '')
            style = re.search(r'style:\s*"([^"]+)"', block)
            weight = re.search(r'weight:\s*(\d+)', block)
            font['style'] = style.group(1) if style else ('italic' if 'italic' in font['filename'].lower() else 'normal')
            font['weight'] = '100 900' if 'wght' in font['filename'] else weight.group(1) if weight else '400'
        if family['name']=='Anton':
            if 'cyrillic' not in family['subsets']:family['subsets'].append('cyrillic')
            bundled=Path(__file__).resolve().parents[1]/'wiki/static/wiki/fonts/office/anton'
            for font in family['fonts']:
                if font['filename']=='Anton-Regular.ttf' and (bundled/'Anton-Regular.ttf').is_file():
                    data=(bundled/'Anton-Regular.ttf').read_bytes()
                    target=directory/font['path']
                    target.write_bytes(data)
                    (target.parent/'OFL.txt').write_bytes((bundled/'OFL.txt').read_bytes())
                    font['stamp']=hashlib.sha256(data).hexdigest()
                    font['source']='MuratKaribay/AntonFont@fd0cd06f2bc9602757fe3065e33772ab3b9b7b7f'
        result.append(family)
    result.sort(key=lambda family: family['name'].casefold())
    if len(result) < 1000:
        raise ValueError('Incomplete Google Fonts catalogue; existing manifest retained.')
    manifest = {'revision': revision, 'families': result}
    with tempfile.NamedTemporaryFile(mode='w', dir=directory, delete=False) as output:
        json.dump(manifest, output, ensure_ascii=False)
        temporary = Path(output.name)
    temporary.chmod(0o644)
    temporary.replace(manifest_path)
    print(f'Installed {len(result)} licensed families / {sum(len(f["fonts"]) for f in result)} font files.', flush=True)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', default='instance/office-fonts')
    parser.add_argument('--revision', help='Pinned full Google Fonts commit SHA')
    args = parser.parse_args()
    install(args.directory, args.revision)
