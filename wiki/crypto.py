import json
from cryptography.fernet import Fernet
from django.conf import settings

def cipher():
    return Fernet((settings.SECRETS_DIR / 'encryption.key').read_bytes())

def encrypt(config):
    return cipher().encrypt(json.dumps(config).encode()).decode()

def decrypt(value):
    return json.loads(cipher().decrypt(value.encode()))
