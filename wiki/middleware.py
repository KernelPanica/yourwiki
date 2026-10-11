import logging
from django.http import JsonResponse
from django.shortcuts import render,redirect
from django.urls import reverse
from django.db import OperationalError
from wiki.models import Workspace

log = logging.getLogger('wiki.access')

def deny(request, reason='access_denied'):
    log.info('access_denied user=%s reason=%s', getattr(getattr(request, 'user', None), 'pk', None), reason)
    if request.path.startswith('/api/') or 'application/json' in request.headers.get('Accept', ''):
        response = JsonResponse({'error': 'Server error'}, status=500)
    else:
        response = render(request, 'wiki/error.html', {'error_title': 'Server error', 'error_message': 'The request could not be completed.'}, status=500)
    if not request.path.startswith('/office/google-fonts/'):
            response['Cache-Control'] = 'no-store'
    return response

class AccessMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def process_exception(self, request, exception):
        from .views import failure
        log.exception('Unhandled action failure: %s %s', request.method, request.path)
        return failure(request, 'The request could not be completed. Check whether the action finished before retrying.', 500)

    def __call__(self, request):
        identity_callback = request.path in tuple('/account/providers/'+p+'/callback/' for p in ('google','onedrive','github'))
        public = request.path.startswith('/office/google-fonts/') or identity_callback or request.path.startswith('/wopi/files/') or request.path in ('/login', '/login/', '/health/', '/i18n/setlang/', '/jsi18n/', '/office/fonts.json', '/mounts/google/callback/') or request.path.startswith('/invite/')
        if not public and not request.user.is_authenticated:
            return deny(request, 'session_required')
        try:
            initialized = Workspace.objects.filter(pk=1, initialized=True).exists()
        except OperationalError:
            initialized = False
        if not initialized and request.path not in ('/health/', '/login', '/login/', '/i18n/setlang/', '/jsi18n/'):
            return deny(request, 'not_initialized')
        if request.user.is_authenticated and request.user.provider_setup_required:
            setup_routes=('/account/setup/','/logout/')
            oauth_route=any(request.path==f'/account/providers/{provider}/{action}/' for provider in ('google','onedrive','github') for action in ('connect','callback','unlink'))
            if not public and request.path not in setup_routes and not oauth_route and not request.path.startswith('/static/'):
                if request.path.startswith('/api/') or 'application/json' in request.headers.get('Accept',''):
                    return JsonResponse({'error':'provider_setup_required','setup_url':reverse('provider-setup')},status=403)
                return redirect('provider-setup')
        response = self.get_response(request)
        # AJAX forms navigate after success themselves. Avoid following the
        # redirect with Fetch and rendering the destination a second time.
        if request.method == 'POST' and response.status_code in (301, 302, 303) and 'application/json' in request.headers.get('Accept', ''):
            from urllib.parse import urlsplit
            destination = response.get('Location', '')
            parsed = urlsplit(destination)
            same_origin = (not parsed.netloc and destination.startswith('/') and not destination.startswith('//')) or (
                parsed.scheme == request.scheme and parsed.netloc == request.get_host())
            if same_origin:
                response = JsonResponse({'url': destination})
        if not request.path.startswith('/office/google-fonts/'):
            response['Cache-Control'] = 'no-store'
        if identity_callback or request.path == '/mounts/google/callback/':
            # Hide the callback query while preserving Origin for the CSRF POST.
            response['Referrer-Policy'] = 'strict-origin'
        response['Content-Security-Policy'] = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        if request.path.endswith('/office/'):
            from django.conf import settings
            from .collabora import origin
            if settings.COLLABORA_URL:
                office_origin = origin(settings.COLLABORA_URL)
                response['Content-Security-Policy'] = response['Content-Security-Policy'].replace(
                    "form-action 'self'", "frame-src 'self' " + office_origin + "; form-action 'self' " + office_origin)
            response['Referrer-Policy'] = 'no-referrer'
        if request.path.startswith('/wopi/'):
            response['Referrer-Policy'] = 'no-referrer'
        if request.path in ('/mounts/', '/storage/') or (request.path.startswith('/account/providers/') and request.path.endswith('/connect/')):
            # Browsers also check form-action on the OAuth POST's redirect.
            response['Content-Security-Policy'] = response['Content-Security-Policy'].replace(
                "form-action 'self'", "form-action 'self' https://accounts.google.com https://login.microsoftonline.com https://github.com")
        return response
