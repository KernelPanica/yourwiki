# Debugging Yourwiki

Start with the container state and application log:

```sh
docker compose ps
docker compose logs --tail=200 web
docker compose logs -f web
curl -i http://127.0.0.1:3000/health/
docker compose exec web python manage.py doctor
```

`/health/` returns 200 after setup and 503 before setup or when SQLite cannot be read. A generic 500 is expected when an anonymous user opens a protected route; its HTML page includes a Sign in link. Both `/login` and `/login/` open the public login form without an existing session. On older images, use `/login/` with the trailing slash. Access denials appear in logs as `access_denied` and should not include invitation tokens or document content.

Run Django diagnostics inside the same image and volumes as production:

```sh
docker compose exec web python manage.py check --deploy
docker compose exec web python manage.py showmigrations
docker compose exec web python manage.py shell
```

The installed public URL is in `/secrets/runtime.json`. Do not paste that file, `/secrets/encryption.key`, cookies, OAuth codes, tokens, passwords, or invitation URLs into issues or logs.

## Setup failures

Run setup interactively and keep its terminal visible:

```sh
docker compose stop web
docker compose run --build --rm --service-ports setup
```

If it reports that port 3000 is occupied, confirm the web service is stopped and inspect the owner of the port with `ss -ltnp | grep ':3000'`. A failed setup is resumable. It does not create the administrator until the storage create/read/update/delete probe succeeds.

For Google Drive or OneDrive, verify that the provider application contains the exact callback printed by setup: `https://YOUR-HOST/setup/oauth/callback`. Confirm that the reverse proxy routes that URL to port 3000 while setup is running. OAuth errors often come from a different scheme, hostname, port, or callback path.

For reconnecting expired or replaced credentials:

```sh
docker compose stop web
docker compose run --rm --service-ports setup --reconnect
docker compose up -d web
```

Reconnect deliberately rejects changes to the provider or storage root.

If setup reports only an unexpected generic failure, rerun it locally with `--debug` to print a traceback. Redact the traceback before sharing it. Provider credentials, authorization codes, tokens, passwords, invitation URLs, cookies, and the contents of `/secrets` must remain private.

## SQLite inspection

Create a safe snapshot before investigating data:

```sh
docker compose exec web python manage.py backup /data/debug-backup.sqlite3
docker compose cp web:/data/debug-backup.sqlite3 ./debug-backup.sqlite3
```

Do not copy a live `wiki.sqlite3` without its WAL files. Do not edit the database manually while the application runs. For a quick integrity check on the backup:

```sh
python3 - <<'PY'
import sqlite3
db = sqlite3.connect('debug-backup.sqlite3')
print(db.execute('pragma integrity_check').fetchone()[0])
db.close()
PY
```

`database is locked` usually means another process is writing the same SQLite volume or more than one web replica is running. Yourwiki supports one `web` replica. Check `docker compose ps`, stop duplicate processes, and retry. The configured busy timeout is 20 seconds.

## Storage failures

Sign in as an administrator and use **Storage → Test connection**. A failed document read/write returns 503. Check container DNS and outbound connectivity, then provider-specific credentials and permissions.

The command-line equivalent performs the same disposable create/read/update/delete probe:

```sh
docker compose exec web python manage.py doctor --storage
```

- Local: confirm `/documents` is writable by UID/GID 10001.
- GitHub: confirm the token has Contents read/write access, the repository and existing branch are correct, and branch protection permits the token.
- SMB: confirm the container can resolve the server, TCP 445 is reachable, SMB2/3 and signing are supported, and the configured directory exists.
- SFTP: confirm TCP 22 (or the configured port), directory permissions, and the exact verified host key. A changed host key is rejected.
- Google Drive/OneDrive: reconnect credentials, confirm API access/scopes, and inspect provider-side authorization status.

Pending physical deletions are kept in SQLite and retried on the configured synchronization interval (three seconds by default). Inspect their count without exposing paths:

```sh
docker compose exec web python manage.py shell -c \
  "from wiki.models import PendingDeletion; print(PendingDeletion.objects.count())"
```

## Local test loop

```sh
.venv/bin/python -m pytest -q
.venv/bin/python -m playwright install chromium
RUN_BROWSER=1 .venv/bin/python -m pytest tests/browser -q
docker compose config --quiet
.venv/bin/python tests/run_container_checks.py
```

The Docker acceptance test needs permission to access `/var/run/docker.sock`. Check with:

```sh
id
stat -c '%A %U %G %n' /var/run/docker.sock
docker info
```

If `docker info` says permission denied, fix the host Docker access for your account or run the checks from a Docker-enabled CI runner. Do not make the socket world-writable.

Live cloud adapter tests are opt-in because they require private provider credentials. Their format is documented in [storage.md](storage.md).

## Temporary development diagnostics

Keep deployed `DEBUG=False`. Reproduce errors with tests or a local-only environment instead of enabling Django debug pages on the public service; those pages can expose settings and request data. When reporting a problem, include the failing command, HTTP status, redacted traceback, `docker compose ps`, image revision, and the first relevant application log lines.
