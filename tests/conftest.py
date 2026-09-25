import os
import tempfile
from pathlib import Path
import pytest
from cryptography.fernet import Fernet

@pytest.fixture
def workspace(db,settings,tmp_path):
    from wiki.models import Workspace,User
    from wiki.crypto import encrypt
    from django.contrib.auth.models import Group
    import wiki.storage
    settings.SECRETS_DIR=tmp_path/'secrets'
    settings.SECRETS_DIR.mkdir()
    (settings.SECRETS_DIR/'encryption.key').write_bytes(Fernet.generate_key())
    root=tmp_path/'documents';root.mkdir()
    ws=Workspace.objects.create(provider='local',encrypted_config=encrypt({'provider':'local','root':str(root)}),initialized=True)
    team=Group.objects.create(name='team')
    admin=User.objects.create_user(username='admin',password='Correct-password-8923',display_name='Admin',is_superuser=True,is_staff=True)
    admin.groups.add(team)
    member=User.objects.create_user(username='member',password='Correct-password-8923',display_name='Member')
    member.groups.add(team)
    outsider=User.objects.create_user(username='outsider',password='Correct-password-8923',display_name='Outsider')
    wiki.storage._mount_cache.clear()
    return {'ws':ws,'admin':admin,'member':member,'outsider':outsider,'team':team,'root':root}

@pytest.fixture
def document(workspace):
    from wiki.services import save_document
    return save_document(workspace['admin'],'A useful document','document','Engineering','# Hello\n\nSome knowledge.',workspace['team'])
