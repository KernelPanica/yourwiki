"""Licensed font catalogues for Collabora and browser editors."""
import json
from pathlib import Path
from django.conf import settings
from django.contrib.staticfiles import finders
from django.http import JsonResponse
from django.templatetags.static import static
from django.views.decorators.http import require_GET


@require_GET
def configuration(request):
    manifest = json.loads(Path(finders.find('wiki/fonts/office/manifest.json')).read_text())
    base = settings.COLLABORA_WOPI_URL.rstrip('/') if settings.COLLABORA_WOPI_URL else request.build_absolute_uri('/').rstrip('/')
    fonts = [{'uri':base + static(item['path']), 'stamp':item['stamp']} for item in manifest]
    fonts.extend({'uri': base + reverse('google-font-file', args=[font['stamp']]), 'stamp':font['stamp']}
                 for family in google_catalogue()['families'] for font in family['fonts'])
    payload = {'kind':'fontconfiguration', 'server':base, 'fonts':fonts}
    import hashlib
    etag = '"'+hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()+'"'
    response = HttpResponse(status=304) if request.headers.get('If-None-Match')==etag else JsonResponse(payload)
    response['ETag'] = etag
    return response



from functools import lru_cache
from django.http import FileResponse, HttpResponse
from django.urls import reverse


@lru_cache(maxsize=4)
def read_catalogue(path, modified):
    return json.loads(Path(path).read_text())


def google_catalogue():
    manifest = Path(settings.GOOGLE_FONTS_DIR)/'google-fonts.json'
    if not manifest.is_file():
        return {'families': []}
    return read_catalogue(str(manifest), manifest.stat().st_mtime_ns)


@require_GET
def catalogue(request):
    return JsonResponse({'families': [{'name': family['name'], 'subsets': family.get('subsets', []),
        'fonts': [{'url': reverse('google-font-file', args=[font['stamp']]), 'style': font.get('style', 'normal'), 'weight': font.get('weight', '400')} for font in family['fonts'] if font.get('declared', True)]}
        for family in google_catalogue()['families']]})


@require_GET
def font_file(request, stamp):
    for family in google_catalogue()['families']:
        for font in family['fonts']:
            if font['stamp'] == stamp:
                root = Path(settings.GOOGLE_FONTS_DIR).resolve()
                license_request=request.GET.get('license')=='1'
                relative=family['licenses'][0] if license_request and family.get('licenses') else font['path']
                path = (root/relative).resolve()
                if not path.is_relative_to(root/'google') or not path.is_file():
                    return HttpResponse(status=404)
                response = FileResponse(path.open('rb'), content_type='text/plain; charset=utf-8' if license_request else 'font/otf' if path.suffix.lower()=='.otf' else 'font/ttf')
                response['Cache-Control']='public, max-age=31536000, immutable'
                if family.get('licenses') and not license_request:
                    response['Link']='<'+reverse('google-font-file',args=[stamp])+'?license=1>; rel="license"'
                response['X-Content-Type-Options'] = 'nosniff'
                return response
    return HttpResponse(status=404)
