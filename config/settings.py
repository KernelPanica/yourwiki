import json
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get('YOURWIKI_DATA', BASE_DIR / 'instance'))
SECRETS_DIR = Path(os.environ.get('YOURWIKI_SECRETS', DATA_DIR / 'secrets'))
DOCUMENTS_DIR = Path(os.environ.get('YOURWIKI_DOCUMENTS', DATA_DIR / 'documents'))
DATA_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_PATH = SECRETS_DIR / 'runtime.json'
RUNTIME = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
SECRET_KEY = RUNTIME.get('django_secret') or os.environ.get('DJANGO_SECRET_KEY', '')
if not SECRET_KEY:
    raise RuntimeError('Run the installer first: python install.py')
DEBUG = False
ALLOWED_HOSTS = RUNTIME.get('allowed_hosts', ['localhost', '127.0.0.1', 'testserver'])
PUBLIC_URL = RUNTIME.get('public_url', 'http://localhost:3000')
INSTALLED_APPS = ['django.contrib.auth', 'django.contrib.contenttypes', 'django.contrib.sessions', 'django.contrib.messages', 'django.contrib.staticfiles', 'wiki.apps.WikiConfig']
MIDDLEWARE = ['django.middleware.security.SecurityMiddleware', 'whitenoise.middleware.WhiteNoiseMiddleware', 'django.contrib.sessions.middleware.SessionMiddleware', 'django.contrib.auth.middleware.AuthenticationMiddleware', 'wiki.middleware.AccessMiddleware', 'django.middleware.csrf.CsrfViewMiddleware', 'django.contrib.messages.middleware.MessageMiddleware', 'django.middleware.clickjacking.XFrameOptionsMiddleware']
ROOT_URLCONF = 'config.urls'
WSGI_APPLICATION = 'config.wsgi.application'
TEMPLATES = [{'BACKEND': 'django.template.backends.django.DjangoTemplates', 'DIRS': [], 'APP_DIRS': True, 'OPTIONS': {'context_processors': ['django.template.context_processors.request', 'django.contrib.auth.context_processors.auth', 'django.contrib.messages.context_processors.messages', 'wiki.context.workspace']}}]
DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': DATA_DIR / 'wiki.sqlite3', 'OPTIONS': {'timeout': 20, 'transaction_mode': 'IMMEDIATE'}}}
AUTH_USER_MODEL = 'wiki.User'
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator', 'OPTIONS': {'min_length': 12}},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]
LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_TZ = True
STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
from wiki.static_headers import add_headers as WHITENOISE_ADD_HEADERS_FUNCTION
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
SESSION_COOKIE_SECURE = PUBLIC_URL.startswith('https://')
CSRF_COOKIE_SECURE = SESSION_COOKIE_SECURE
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = 'Strict'
SESSION_COOKIE_AGE = 86400
SESSION_SAVE_EVERY_REQUEST = False
CSRF_TRUSTED_ORIGINS = [PUBLIC_URL]
CSRF_FAILURE_VIEW = 'wiki.views.denied'
# Compose binds only to loopback; the documented proxy must overwrite this header.
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
SECURE_CONTENT_TYPE_NOSNIFF = True
# Keep same-origin form submissions verifiable by Django's CSRF middleware while
# withholding referrer information from cross-origin destinations.
SECURE_REFERRER_POLICY = 'same-origin'
X_FRAME_OPTIONS = 'DENY'
DATA_UPLOAD_MAX_MEMORY_SIZE = 6 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024
LOGGING = {'version': 1, 'disable_existing_loggers': False, 'handlers': {'console': {'class': 'logging.StreamHandler'}}, 'loggers': {'wiki': {'handlers': ['console'], 'level': 'INFO', 'propagate': False}}}
