"""Install the two default Microsoft Core Fonts privately (never into Git)."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request

LICENSE='https://corefonts.sourceforge.net/eula.htm'
# Checksums: https://sources.debian.org/src/msttcorefonts/3.8.1/
PACKAGES={
 'impact32.exe':('6061ef3b7401d9642f5dfdb5f2b376aa14663f6275e60a51207ad4facf2fccfb',{
  'Impact.TTF':'00f1fc230ac99f9b97ba1a7c214eb5b909a78660cb3826fca7d64c3af5a14848'}),
 'times32.exe':('db56595ec6ef5d3de5c24994f001f03b2a13e37cee27bc25c58f6f43e8f807ab',{
  'Times.TTF':'4e98adeff8ccc8ef4e3ece8d4547e288ff85fdc9c7ca711a4599c234874bbe86',
  'Timesbd.TTF':'4357b63cef20c01661a53c5dae70ffd20cb4765503aaed6d38b17a57c5a90bff',
  'Timesi.TTF':'c25ae529b4cecdbca148b6ccb862ee0abad770af8b1fd29c8dba619d1b8da78a',
  'Timesbi.TTF':'192e1b0d18e90334e999a99f8c32808d6a2e74b3698b8cd90c943c2249a46549'}),
}

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--accept-eula',action='store_true',help=LICENSE)
 parser.add_argument('--directory',type=Path,default=Path('instance/office-fonts'))
 parser.add_argument('--active-directory',type=Path,default=Path('instance/office-active-fonts'))
 args=parser.parse_args()
 if not args.accept_eula: parser.error('Read '+LICENSE+' and pass --accept-eula.')
 if not shutil.which('cabextract'): parser.error('Install cabextract first.')
 args.directory.mkdir(parents=True,exist_ok=True);args.active_directory.mkdir(parents=True,exist_ok=True)
 downloads=args.directory.parent/'font-downloads';downloads.mkdir(exist_ok=True)
 for package,(checksum,fonts) in PACKAGES.items():
  archive=downloads/package
  data=archive.read_bytes() if archive.is_file() else urllib.request.urlopen('https://downloads.sourceforge.net/corefonts/'+package,timeout=45).read()
  if hashlib.sha256(data).hexdigest()!=checksum: raise RuntimeError('Archive checksum mismatch: '+package)
  archive.write_bytes(data)
  with tempfile.TemporaryDirectory() as temp:
   subprocess.run(['cabextract','-q','-d',temp,str(archive.resolve())],check=True)
   for filename,expected in fonts.items():
    binary=(Path(temp)/filename).read_bytes()
    if hashlib.sha256(binary).hexdigest()!=expected: raise RuntimeError('Font checksum mismatch: '+filename)
    (args.directory/filename).write_bytes(binary);(args.active_directory/filename).write_bytes(binary)
 print('Impact and Times New Roman installed. Save active documents before restarting Collabora.')

if __name__=='__main__':main()
