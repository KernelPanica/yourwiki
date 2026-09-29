import pytest

from django.test import TestCase, override_settings


@override_settings(ALLOWED_HOSTS=['testserver'])
class LanguageSwitchTests(TestCase):
    def test_language_switch_sets_cookie_and_redirects(self):
        response = self.client.post('/i18n/setlang/', {'language': 'es', 'next': '/login/'})
        assert response.status_code == 302
        assert response.cookies['django_language'].value == 'es'
        assert response['Location'] == '/login/'
        assert 'Bienvenido de nuevo' in self.client.get('/login/').content.decode()


def test_russian_workspace_and_english_fallback(client, workspace, document):
    from django.utils.translation import ngettext, override

    response = client.get('/login/', HTTP_ACCEPT_LANGUAGE='ru-RU,ru;q=0.9')
    assert response['Content-Language'] == 'ru'
    assert '<html lang="ru">' in response.content.decode()
    assert 'С возвращением.' in response.content.decode()

    client.post('/i18n/setlang/', {'language': 'ru', 'next': '/login/'})
    client.force_login(workspace['admin'])
    pages = {
        '/': 'Все документы', '/folders/': 'Файлы',
        '/account/': 'Ваш аккаунт', '/documents/new/': 'Создать и открыть редактор',
        '/files/upload/': 'Загрузить файл', '/documents/import/': 'Импорт документа',
        '/folders/new/': 'Создать каталог', '/members/': 'Участники и группы',
        '/groups/': 'Создать группу', '/invitations/': 'Создать приглашение',
        '/permissions/': 'Права доступа', '/settings/': 'Настройки сайта',
        '/mounts/': 'Точки подключения',
        f'/documents/{document.pk}/live/': 'Сохранить сейчас',
        f'/documents/{document.pk}/': 'К документам',
        f'/documents/{document.pk}/delete/': 'Удалить «A useful document»?',
    }
    for url, translated in pages.items():
        response = client.get(url)
        assert response.status_code == 200, url
        html = response.content.decode()
        assert '<html lang="ru">' in html, url
        assert translated in html, url
        assert 'A useful document' in html, url  # User content stays intact.

    html = client.get('/documents/new/').content.decode()
    assert '>Документ</option>' in html
    assert '>Название</label>' in html
    catalog = client.get('/jsi18n/').content.decode()
    assert 'Undo' in catalog
    import json
    assert json.dumps('Отменить')[1:-1] in catalog
    with override('ru'):
        for count, expected in [(1, 'файл'), (2, 'файла'), (5, 'файлов'), (11, 'файлов'), (21, 'файл')]:
            assert ngettext('%(count)s file', '%(count)s files', count) % {'count': count} == f'{count} {expected}'
    client.post('/i18n/setlang/', {'language': 'en', 'next': '/'})
    response = client.get('/')
    assert '<html lang="en">' in response.content.decode()
    assert 'All documents' in response.content.decode()


def test_spanish_workspace_and_editor_catalog(client, workspace, document):
    import json
    from django.utils.translation import ngettext, override

    client.force_login(workspace['admin'])
    client.post('/i18n/setlang/', {'language': 'es', 'next': '/'})
    pages = {
        '/': 'Buscar documentos', '/folders/': 'Archivos',
        '/account/': 'Tu cuenta', '/documents/new/': 'Crear y abrir editor',
        '/files/upload/': 'Subir archivo', '/documents/import/': 'Importar un documento',
        '/folders/new/': 'Crear directorio', '/members/': 'Personas y grupos',
        '/groups/': 'Crear grupo', '/invitations/': 'Crear invitación',
        '/permissions/': 'Permisos', '/settings/': 'Administración del sitio',
        '/mounts/': 'Puntos de montaje', '/settings/ai/': 'Ajustes de IA',
        f'/documents/{document.pk}/live/': 'Guardar ahora',
        f'/documents/{document.pk}/': 'Volver a los documentos',
        f'/documents/{document.pk}/delete/': '¿Eliminar A useful document?',
    }
    for url, translated in pages.items():
        response = client.get(url)
        assert response.status_code == 200, url
        assert '<html lang="es">' in response.content.decode(), url
        assert translated in response.content.decode(), url
    catalog = client.get('/jsi18n/').content.decode()
    for value in ['Deshacer', 'Añadir texto', 'Guardar PDF', 'Sincronizado con el almacenamiento']:
        assert json.dumps(value)[1:-1] in catalog
    with override('es'):
        assert ngettext('%(count)s file', '%(count)s files', 1) % {'count': 1} == '1 archivo'
        assert ngettext('%(count)s file', '%(count)s files', 2) % {'count': 2} == '2 archivos'


def test_spanish_catalog_covers_workspace_strings():
    import gettext
    import re
    from pathlib import Path
    from django.conf import settings

    catalogs = {}
    for language in ('ru', 'es'):
        with (Path(settings.BASE_DIR) / 'locale' / language / 'LC_MESSAGES/django.mo').open('rb') as source:
            catalogs[language] = gettext.GNUTranslations(source)._catalog
    for key in catalogs['ru']:
        if not key or isinstance(key, tuple) and key[1] == 2:
            continue
        assert catalogs['es'].get(key), key
        source = key[0] if isinstance(key, tuple) else key
        assert sorted(re.findall(r'%\([^)]+\)[sd]', source)) == sorted(re.findall(r'%\([^)]+\)[sd]', catalogs['es'][key])), key


@pytest.mark.parametrize('language', ['en', 'ru', 'es'])
@pytest.mark.parametrize('kind', ['canvas', 'drawio'])
def test_graph_preview_uses_unlocalized_geometry(client, workspace, language, kind):
    import json
    import re
    from xml.etree import ElementTree
    from wiki.services import save_document

    if kind == 'canvas':
        content = json.dumps({'nodes': [
            {'id': 'a', 'type': 'text', 'text': 'Card A', 'x': -12.5, 'y': 24.75, 'width': 240.5, 'height': 120.25},
            {'id': 'b', 'type': 'text', 'text': 'Card B', 'x': 320.5, 'y': 240.75, 'width': 240.5, 'height': 120.25},
        ], 'edges': [{'id': 'e', 'fromNode': 'a', 'toNode': 'b', 'label': 'Connection'}]})
    else:
        content = '<mxGraphModel><root><mxCell id="a" vertex="1" value="Card A"><mxGeometry x="-12.5" y="24.75" width="240.5" height="120.25"/></mxCell><mxCell id="b" vertex="1" value="Card B"><mxGeometry x="320.5" y="240.75" width="240.5" height="120.25"/></mxCell><mxCell id="e" edge="1" source="a" target="b" value="Connection"/></root></mxGraphModel>'
    doc = save_document(workspace['admin'], 'Geometry', kind, 'Tests', content, workspace['team'])
    client.force_login(workspace['admin'])
    client.cookies['django_language'] = language
    response = client.get(f'/documents/{doc.pk}/')
    assert response.status_code == 200
    svg = ElementTree.fromstring(re.search(r'<svg class="graph".*?</svg>', response.content.decode()).group())
    card = svg.find('rect')
    assert card.attrib['x'] == '-12.5'
    assert card.attrib['y'] == '24.75'
    assert card.attrib['width'] == '240.5'
    assert card.attrib['height'] == '120.25'
    for element in [*svg.findall('rect'), *svg.findall('foreignObject'), *svg.findall('text')]:
        for name in ('x', 'y', 'width', 'height'):
            if name in element.attrib:
                assert ',' not in element.attrib[name]
                float(element.attrib[name])
