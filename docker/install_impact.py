"""Install the unchanged Microsoft Core Fonts Impact privately for Collabora."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request

URL = 'https://downloads.sourceforge.net/corefonts/impact32.exe'
ARCHIVE_SHA256 = '6061ef3b7401d9642f5dfdb5f2b376aa14663f6275e60a51207ad4facf2fccfb'
FONT_SHA256 = '00f1fc230ac99f9b97ba1a7c214eb5b909a78660cb3826fca7d64c3af5a14848'
LICENSE = 'https://corefonts.sourceforge.net/eula.htm'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--accept-eula', action='store_true', help='Accept the Microsoft Core Fonts EULA: '+LICENSE)
    parser.add_argument('--directory', type=Path, default=Path('instance/office-fonts'))
    args = parser.parse_args()
    if not args.accept_eula:
        parser.error('Read '+LICENSE+' and pass --accept-eula to install.')
    if not shutil.which('cabextract'):
        parser.error('Install cabextract first (Debian: apt-get install cabextract).')
    data = urllib.request.urlopen(URL, timeout=45).read()
    if hashlib.sha256(data).hexdigest() != ARCHIVE_SHA256:
        raise RuntimeError('Downloaded Core Fonts archive does not match the expected checksum.')
    args.directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        archive = Path(temporary)/'impact32.exe';archive.write_bytes(data)
        subprocess.run(['cabextract','-q','-d',temporary,str(archive)], check=True)
        font = (Path(temporary)/'Impact.TTF').read_bytes()
        if hashlib.sha256(font).hexdigest() != FONT_SHA256:
            raise RuntimeError('Extracted Impact font does not match the expected checksum.')
        (args.directory/'Impact.TTF').write_bytes(font)
    downloads = args.directory.parent/'font-downloads';downloads.mkdir(exist_ok=True)
    (downloads/'impact32.exe').write_bytes(data)
    (downloads/'EULA.html').write_bytes(urllib.request.urlopen(LICENSE,timeout=30).read())
    print('Impact installed privately at '+str(args.directory)+'. Restart Collabora to load it.')


if __name__ == '__main__':
    main()
