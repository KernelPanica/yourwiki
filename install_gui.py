"""Private, one-use browser setup UI; no dependency on an initialized Django site."""
import json
import os
from pathlib import Path
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
import webbrowser

MAX_BODY = 64 * 1024


def serve(args):
    import install
    token = secrets.token_urlsafe(32)
    state = {'phase': 'ready', 'message': 'Заполните настройки установки.', 'oauth_url': None}
    mutex = threading.Lock()
    oauth_done = threading.Event()
    oauth_result = {}
    oauth_state = None

    def update(**values):
        with mutex:
            state.update(values)

    def authorize(config, public_url):
        nonlocal oauth_state
        oauth_state = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(64)
        redirect = public_url + '/setup/oauth/callback'
        oauth_done.clear()
        oauth_result.clear()
        update(phase='authorization', message='Разрешите доступ к хранилищу в открывшейся вкладке.',
               oauth_url=install.authorization_url(config, redirect, oauth_state, verifier))
        if not oauth_done.wait(600):
            raise ValueError('Время авторизации истекло. Повторите установку.')
        update(phase='running', message='Проверяем подключение к хранилищу…', oauth_url=None)
        if 'code' not in oauth_result:
            raise ValueError('Доступ к хранилищу не предоставлен.')
        install.exchange_code(config, redirect, oauth_result['code'], verifier)
        oauth_state = None

    def worker(config):
        try:
            from argparse import Namespace
            settings = Namespace(**vars(args))
            settings.supplied_config = config
            settings.authorize_callback = authorize
            settings.progress = lambda message: update(message=message)
            install.run(settings)
            update(phase='complete', message='Установка завершена. Запустите сервис Yourwiki и войдите.',
                   login_url=config['public_url'].rstrip('/') + '/login/', oauth_url=None)
        except Exception as exc:
            # Known validation errors contain actionable messages, never tracebacks/tokens.
            from django.core.exceptions import ValidationError
            from wiki.storage import StorageError
            message = '; '.join(exc.messages) if isinstance(exc, ValidationError) else str(exc) if isinstance(exc, (ValueError, StorageError)) else 'Ошибка установки. Проверьте настройки, доступность хранилища и права на каталоги.'
            update(phase='error', message=message, oauth_url=None)
        finally:
            from django.conf import settings
            if settings.configured:
                from django.db import connections
                connections.close_all()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def respond(self, status, body, kind='application/json; charset=utf-8'):
            if isinstance(body, dict):
                body = json.dumps(body, ensure_ascii=False).encode()
            elif isinstance(body, str):
                body = body.encode()
            self.send_response(status)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(body)

        def authenticated(self):
            return secrets.compare_digest(self.headers.get('X-Setup-Token', ''), token)

        def do_GET(self):
            nonlocal oauth_state
            parsed = urlparse(self.path)
            if parsed.path == '/setup/oauth/callback':
                params = parse_qs(parsed.query)
                supplied = params.get('state', [''])[0]
                if not oauth_state or not secrets.compare_digest(supplied, oauth_state) or oauth_done.is_set() or not (params.get('code') or params.get('error')):
                    self.respond(400, 'Ссылка авторизации недействительна или устарела.', 'text/plain; charset=utf-8')
                    return
                oauth_result.update({key: values[0] for key, values in params.items() if key in ('code', 'error')})
                oauth_done.set()
                self.respond(200, 'Авторизация получена. Вернитесь во вкладку установщика.', 'text/plain; charset=utf-8')
            elif parsed.path in ('/', '/setup/'):
                self.respond(200, Path(__file__).with_name('install_ui.html').read_bytes(), 'text/html; charset=utf-8')
            elif parsed.path == '/setup/status' and self.authenticated():
                with mutex:
                    snapshot = dict(state)
                self.respond(200, snapshot)
            else:
                self.respond(403, {'error': 'Откройте приватную ссылку установщика.'})

        def do_POST(self):
            if self.path != '/setup/install' or not self.authenticated():
                self.respond(403, {'error': 'Нет доступа к установщику.'})
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= MAX_BODY:
                    raise ValueError('Настройки слишком велики или отсутствуют.')
                config = json.loads(self.rfile.read(length))
                if not isinstance(config, dict) or not isinstance(config.get('storage'), dict) or not isinstance(config.get('admin'), dict):
                    raise ValueError('Заполните настройки администратора и хранилища.')
                if not isinstance(config.get('public_url'), str):
                    raise ValueError('Укажите адрес сайта.')
                if any(not isinstance(value, str) for value in config['admin'].values()):
                    raise ValueError('Неверные настройки администратора.')
                if not all(config['admin'].get(key) for key in ('username', 'password')):
                    raise ValueError('Укажите логин и пароль администратора.')
                for key, value in config['storage'].items():
                    if key == 'port':
                        if type(value) is not int or not 1 <= value <= 65535:
                            raise ValueError('Неверный порт хранилища.')
                    elif not isinstance(value, str):
                        raise ValueError('Неверные параметры хранилища.')
                config['admin']['display_name'] = config['admin'].get('display_name') or config['admin']['username']
                install.validate_config(config['storage'])
                with mutex:
                    if state['phase'] not in ('ready', 'error'):
                        self.respond(409, {'error': 'Установка уже выполняется или завершена.'})
                        return
                    state.update(phase='running', message='Подготавливаем базу данных…', oauth_url=None)
                threading.Thread(target=worker, args=(config,), daemon=True).start()
                self.respond(202, {'started': True})
            except (ValueError, TypeError, KeyError):
                self.respond(400, {'error': 'Проверьте обязательные поля и настройки выбранного хранилища.'})

    host = args.bind
    port = args.port
    server = ThreadingHTTPServer((host, port), Handler)
    display_host = '127.0.0.1' if host == '0.0.0.0' else host
    base = os.environ.get('SETUP_BROWSER_URL', f'http://{display_host}:{server.server_port}').rstrip('/')
    url = f'{base}/setup/#token={token}'
    print('Откройте приватную ссылку установщика в браузере:\n' + url, flush=True)
    print('Для удалённого сервера используйте SSH-туннель или HTTPS-прокси. Не передавайте ссылку другим людям.', flush=True)
    if host in ('localhost', '127.0.0.1'):
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0
