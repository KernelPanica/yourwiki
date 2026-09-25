"""Retry pending remote file deletion without a separate worker service."""
def post_worker_init(worker):
    import threading
    import time
    def cleanup():
        from django.db import close_old_connections
        from wiki.services import cleanup_storage
        while True:
            try:
                close_old_connections()
                cleanup_storage()
            except Exception:
                worker.log.warning('Storage cleanup deferred; retrying in 30 seconds.')
            finally:
                close_old_connections()
            time.sleep(30)
    threading.Thread(target=cleanup,daemon=True,name='storage-cleanup').start()
