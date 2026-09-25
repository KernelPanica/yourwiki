# Deployment and operations

## Reverse proxy

The application and one-time installer bind port 8000 inside the container. Compose publishes it on host loopback port 3000. Set `YOURWIKI_PORT` for a different host port. The setup and application services must not run simultaneously because they share this port.

Example Nginx location within your existing HTTPS server:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    client_max_body_size 60m;
    proxy_read_timeout 120s;
}
```

The trusted proxy must overwrite `X-Forwarded-Proto`. Do not expose the application directly with untrusted forwarded headers. Keep the configured public URL's hostname and HTTPS scheme unchanged unless you update `/secrets/runtime.json` and restart the application.

If your proxy is another container, attach it to the Compose network and route to `web:8000` during normal operation. During OAuth setup, route to the setup service/container on the same network instead; `docker compose run --use-aliases --rm --service-ports setup` enables the `setup` alias. Host-based proxy routing requires no switch between setup and application. Docker Desktop supports the default host-loopback publishing; remote SMB/SFTP services are reached from inside the container and need resolvable hostnames.

Only one application replica is supported. Uvicorn runs one ASGI process for HTTP and WebSockets. SQLite uses WAL, foreign keys, a 20-second busy timeout, and short immediate write transactions. Database writes are not held open across remote storage calls. SQLite must stay on a local volume, never SMB/SFTP/cloud storage. WebSocket Origin must match the installed public URL exactly.

## Setup and secrets

```sh
docker compose run --build --rm --service-ports setup
docker compose up -d web
```

Setup writes application secrets and the public origin to the `secrets` volume with restrictive file permissions. Provider configuration is encrypted in SQLite using a key in that volume. Setup obtains an exclusive local file lock and can resume incomplete installations. The first administrator is committed only after successful storage verification.

Unattended setup accepts a private JSON file using `--config`. Mount it read-only and ensure UID 10001 can read it. Do not put passwords in command arguments or commit this file.

```json
{
  "public_url": "https://wiki.example.com",
  "admin": {
    "username": "owner",
    "display_name": "Owner",
    "password": "replace-with-a-unique-long-password"
  },
  "storage": {"provider": "local", "root": "/documents"}
}
```

```sh
docker compose run --rm --service-ports \
  -v /absolute/path/setup-private.json:/run/setup.json:ro \
  setup --config /run/setup.json
```

Cloud configs without a refresh token still open the guided browser authorization flow. Test/automation configs can supply pre-provisioned refresh tokens. Remove your setup input file from the host when it is no longer needed.

The image runs as UID/GID 10001. Newly created named volumes inherit the image's ownership. For bind mounts, provision writable directories owned by that UID first. The root filesystem is read-only; `/data`, `/documents`, `/secrets`, and `/tmp` are the writable locations.

## Reconnect credentials

```sh
docker compose stop web
docker compose run --rm --service-ports setup --reconnect
docker compose up -d web
```

Reconnect retains provider, root, repository/branch, network host/share, and SSH host key. It cannot move files or create a new storage root. Provide credentials for the original account/root. Failed validation does not replace an initialized connection. The existing runtime and encryption keys are preserved.

## Backup and restore

Create a consistent database snapshot while running:

```sh
docker compose exec web python manage.py backup /data/backup.sqlite3
```

The destination must not exist. Copy the snapshot out using `docker compose cp web:/data/backup.sqlite3 ./backup.sqlite3`. Also back up the entire secrets volume and your document storage; the database alone cannot reconstruct documents or decrypt provider credentials. For a coordinated full backup, stop the application before copying documents and secrets. Old immutable revision files may be retained in provider backups.

To restore, stop the app, replace the database with the snapshot in its local volume, remove stale `wiki.sqlite3-wal` and `wiki.sqlite3-shm` files from the stopped instance, restore the matching secrets and documents, ensure UID 10001 ownership, and start the app. Do not copy a live SQLite main file without its WAL; use the backup command instead.

## Upgrades and diagnostics

Back up first, then build the updated image and recreate the web service:

```sh
docker compose build
docker compose up -d web
```

The entrypoint applies Django migrations before Uvicorn starts. Startup refuses an uninitialized workspace. An incompatible or failed migration stops startup rather than skipping it. Restore the full backup to roll back a database change. This upgrade adds collections, site configuration, reviews, attachments, and collaboration state without changing existing document permissions. Existing collection labels remain labels; existing documents start at the workspace root.

`/health/` checks database access and initialization and returns only readiness, not credentials or document information. Use Storage → Test connection for an administrator-only provider check. Application logs go to container stderr; access-denial events use the `wiki.access` logger. Access logs are disabled to avoid logging invitation tokens. Configure your reverse proxy not to record invitation URLs or OAuth authorization codes.

Deleted documents are removed from the catalog immediately. A durable SQLite queue tracks pending remote deletion, including uploaded images. ASGI maintenance retries pending deletion and collaboration snapshots on the configured synchronization interval (three seconds by default). Older revision files are not deleted. The database health check does not claim that an external provider is available.

## Collaborative editor durability

An edit is acknowledged only after its merged state is committed to SQLite. “Saved locally” means the database volume contains the edit; “Synced to storage” means the configured provider has received its snapshot. Provider outages do not erase acknowledged edits. Pending snapshots retry after a restart. Backups must include SQLite because it can contain newer content than a temporarily unavailable provider, as well as reviews and attachment metadata.

Keep a disconnected editor tab open until it reports a successful save; edits that have never reached the server are still only in that tab. Source editing takes an exclusive 15-minute lease and requires other visual editors to close first. Save or cancel the source session to release it immediately.

The Docker build bundles JavaScript editor assets and downloads an integrity-pinned draw.io release. Node is a build dependency only; the runtime remains Python with SQLite. No editor CDN, external collaboration service, or paid license is required.
