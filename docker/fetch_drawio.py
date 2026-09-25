"""Fetch an integrity-pinned release and install client-only draw.io assets."""
import hashlib
from pathlib import Path
import shutil
import sys
import tempfile
import urllib.request
import zipfile

VERSION = '31.4.5'
SHA256 = '6ee1ce19242bbabf348c52e41e1fe17057d57236e731acf48d7a3710ca50c375'
target = Path('wiki/static/drawio')
with tempfile.TemporaryDirectory() as temporary:
    archive = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(temporary)/'draw.war'
    if len(sys.argv) == 1:
        urllib.request.urlretrieve(f'https://github.com/jgraph/drawio/releases/download/v{VERSION}/draw.war', archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        raise SystemExit('draw.io checksum mismatch')
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            path = Path(entry.filename)
            if entry.is_dir() or path.is_absolute() or '..' in path.parts or path.parts[0] in ('WEB-INF','META-INF'):
                continue
            out = target/path
            out.parent.mkdir(parents=True, exist_ok=True)
            with source.open(entry) as data, out.open('wb') as dest:
                shutil.copyfileobj(data, dest)
    with (target/'js/PostConfig.js').open('a') as output:
        output.write('\nwindow.DRAWIO_CONFIG = {defaultFonts:["Arial","Georgia","Verdana"]};\n')
        output.write('\nApp.initPluginCallback(); Draw.loadPlugin(function(ui) { window.yourwikiEditor = ui; });\n')
print('Installed draw.io '+VERSION)
