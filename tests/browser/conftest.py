import socket
import threading
import time
import pytest
import uvicorn
from django.contrib.staticfiles.handlers import ASGIStaticFilesHandler

@pytest.fixture
def realtime_server(settings,workspace):
    from config.asgi import application
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    url=f'http://127.0.0.1:{port}';settings.PUBLIC_URL=url
    server=uvicorn.Server(uvicorn.Config(ASGIStaticFilesHandler(application),host='127.0.0.1',port=port,log_level='warning',lifespan='on'))
    thread=threading.Thread(target=server.run,kwargs={'sockets':[sock]},daemon=True);thread.start()
    for _ in range(100):
        if server.started:break
        time.sleep(.05)
    assert server.started
    yield url
    server.should_exit=True;thread.join(timeout=10);sock.close()

