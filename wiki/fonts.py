"""Licensed font catalogues for Collabora and browser editors."""
import json
from pathlib import Path
from django.conf import settings
from django.core.exceptions import ValidationError
from django.contrib.staticfiles import finders
from django.http import JsonResponse
from django.templatetags.static import static
from django.views.decorators.http import require_GET


@require_GET
def configuration(request):
    manifest = json.loads(Path(finders.find('wiki/fonts/office/manifest.json')).read_text())
    base = settings.COLLABORA_WOPI_URL.rstrip('/') if settings.COLLABORA_WOPI_URL else request.build_absolute_uri('/').rstrip('/')
    from .models import OfficeFontActivation
    active = {'Times New Roman', 'Impact', *OfficeFontActivation.objects.values_list('name', flat=True)}
    bundled = {'Tinos':'tinos', 'Anton':'anton', 'Oswald':'oswald', 'Arimo':'arimo', 'Cousine':'cousine', 'Roboto':'roboto', 'Open Sans':'opensans'}
    paths = {bundled[name] for name in active if name in bundled}
    if not private_font_path('times').is_file(): paths.add('tinos')
    if not private_font_path('impact').is_file(): paths.add('oswald')
    fonts = [{'uri':base + static(item['path']), 'stamp':item['stamp']} for item in manifest if item['path'].split('/')[-2] in paths]
    fonts.extend({'uri': base + reverse('google-font-file', args=[font['stamp']]), 'stamp':font['stamp']}
                 for family in google_catalogue()['families'] if family['name'] in active and family['name'] not in bundled and family['name'] not in ('Times New Roman', 'Impact') for font in family['fonts'])
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
    return JsonResponse({'families': private_families() + [{'name': family['name'], 'subsets': family.get('subsets', []),
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


from django.views.decorators.http import require_POST

@require_POST
def activate(request):
    """Activate a registered family, never a caller-provided file or URL."""
    from .models import OfficeFontActivation, Document
    if not request.user.is_authenticated:
        return JsonResponse({'error': 'Authentication required'}, status=403)
    try:
        document = Document.objects.get(pk=request.POST.get('document'))
    except (Document.DoesNotExist, ValueError, TypeError, ValidationError):
        return JsonResponse({'error': 'Document unavailable'}, status=404)
    if not document.allows(request.user, 'write'):
        return JsonResponse({'error': 'Write access required'}, status=403)
    name = request.POST.get('name', '')
    names = {family['name'] for family in google_catalogue()['families']}
    names.update(('Times New Roman', 'Impact', 'Arimo', 'Tinos', 'Anton', 'Oswald', 'Cousine', 'Roboto', 'Open Sans'))
    if name not in names:
        return JsonResponse({'error': 'Unknown font'}, status=400)
    _, created = OfficeFontActivation.objects.get_or_create(name=name)
    return JsonResponse({'name': name, 'created': created, 'refresh_seconds': 60})


def activate_document_fonts(data):
    """Retain registered fonts used in existing office files without fetching the catalogue."""
    import io
    import zipfile
    from lxml import etree
    from .file_formats import checked_archive
    from .models import OfficeFontActivation
    if not zipfile.is_zipfile(io.BytesIO(data)):
        return
    known = {family['name'] for family in google_catalogue()['families']}
    known.update(('Times New Roman', 'Impact', 'Arimo', 'Tinos', 'Anton', 'Oswald', 'Cousine', 'Roboto', 'Open Sans'))
    names = set()
    with checked_archive(data) as archive:
        for entry in archive.infolist():
            if not entry.filename.endswith('.xml') or entry.file_size > 4 * 1024 * 1024:
                continue
            if not (entry.filename in ('styles.xml', 'content.xml') or entry.filename.startswith(('word/', 'xl/', 'ppt/'))):
                continue
            root = etree.fromstring(archive.read(entry), etree.XMLParser(resolve_entities=False, no_network=True))
            for element in root.iter():
                for key, value in element.attrib.items():
                    local = key.rsplit('}', 1)[-1]
                    if local in ('ascii', 'hAnsi', 'cs', 'eastAsia', 'typeface', 'font-family') or (local == 'val' and element.tag.rsplit('}', 1)[-1] == 'name'):
                        name = value.strip(" '\"")
                        if name in known:
                            names.add(name)
    existing = set(OfficeFontActivation.objects.filter(name__in=names).values_list('name', flat=True))
    OfficeFontActivation.objects.bulk_create([OfficeFontActivation(name=name) for name in names-existing], ignore_conflicts=True)


PRIVATE_FONTS = {
    'impact': ('Impact.TTF', 'Impact', 'normal', '400'),
    'times': ('Times.TTF', 'Times New Roman', 'normal', '400'),
    'timesbd': ('Timesbd.TTF', 'Times New Roman', 'normal', '700'),
    'timesi': ('Timesi.TTF', 'Times New Roman', 'italic', '400'),
    'timesbi': ('Timesbi.TTF', 'Times New Roman', 'italic', '700'),
}


def private_font_path(key):
    return Path(settings.GOOGLE_FONTS_DIR)/PRIVATE_FONTS[key][0]


def private_families():
    families = {}
    for key, (_, name, style, weight) in PRIVATE_FONTS.items():
        if private_font_path(key).is_file():
            family = families.setdefault(name, {'name':name, 'subsets':['latin','cyrillic'], 'fonts':[]})
            family['fonts'].append({'url':reverse('private-font-file', args=[key]), 'style':style, 'weight':weight})
    return list(families.values())


@require_GET
def private_font_file(request, key):
    # The fixed whitelist cannot expose other files from the private font directory.
    if not request.user.is_authenticated or not request.user.is_active:
        return HttpResponse(status=403)
    if key not in PRIVATE_FONTS or not private_font_path(key).is_file():
        return HttpResponse(status=404)
    response = FileResponse(private_font_path(key).open('rb'), content_type='font/ttf')
    response['Cache-Control'] = 'private, max-age=86400'
    response['X-Content-Type-Options'] = 'nosniff'
    return response
