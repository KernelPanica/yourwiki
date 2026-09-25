"""Isolated settings for tests; never used by the deployed container."""
import os
import tempfile
from pathlib import Path
_test_data=tempfile.TemporaryDirectory(prefix='yourwiki-test-db-')
os.environ['YOURWIKI_DATA']=_test_data.name
os.environ['YOURWIKI_SECRETS']=str(Path(_test_data.name)/'secrets')
os.environ['YOURWIKI_DOCUMENTS']=str(Path(_test_data.name)/'documents')
os.environ['DJANGO_SECRET_KEY']='test-only-not-for-deployment'
from .settings import *
PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher']
DATABASES['default']['TEST']={'NAME': str(Path(_test_data.name)/'test.sqlite3')}
