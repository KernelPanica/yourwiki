import logging
from django.http import JsonResponse
from django.shortcuts import render
from django.db import OperationalError
from wiki.models import Workspace

log = logging.getLogger('wiki.access')

def deny(request, reason='access_denied'):
    log.info('access_denied user=%s reason=%s', getattr(getattr(request, 'user', None), 'pk', None), reason)
    if request.path.startswith('/api/') or 'application/json' in request.headers.get('Accept', ''):
        response = JsonResponse({'error': 'Server error'}, status=500)
    else:
        response = render(request, 'wiki/error.html', {'error_title': 'Server error', 'error_message': 'The request could not be completed.'}, status=500)
    response['Cache-Control'] = 'no-store'
    return response

class AccessMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        public = request.path in ('/login', '/login/', '/health/', '/i18n/setlang/', '/jsi18n/', '/mounts/google/callback/') or request.path.startswith('/invite/')
        if not public and not request.user.is_authenticated:
            return deny(request, 'session_required')
        try:
            initialized = Workspace.objects.filter(pk=1, initialized=True).exists()
        except OperationalError:
            initialized = False
        if not initialized and request.path not in ('/health/', '/login', '/login/', '/i18n/setlang/', '/jsi18n/'):
            return deny(request, 'not_initialized')
        response = self.get_response(request)
        response['Cache-Control'] = 'no-store'
        if request.path == '/mounts/google/callback/':
            # Hide the callback query while preserving Origin for the CSRF POST.
            response['Referrer-Policy'] = 'strict-origin'
        response['Content-Security-Policy'] = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        if request.path in ('/mounts/', '/storage/'):
            # Browsers also check form-action on the OAuth POST's redirect.
            response['Content-Security-Policy'] = response['Content-Security-Policy'].replace(
                "form-action 'self'", "form-action 'self' https://accounts.google.com")
        return response
