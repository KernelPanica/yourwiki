import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
from django.core.asgi import get_asgi_application
django_application = get_asgi_application()
from wiki.realtime import application as realtime_application


async def application(scope, receive, send):
    if scope['type'] in ('websocket','lifespan'):
        return await realtime_application(scope, receive, send)
    return await django_application(scope, receive, send)
