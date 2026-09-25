# Yourwiki

A Docker-first wiki built with **Python, Django, and a local SQLite database**. Server-rendered pages provide a directory explorer, document library, search, stars, documents, tables, draw.io diagrams, and Obsidian Canvas. Docker builds the self-hosted visual editors; no separate database server is required.

## Install with Docker

Prerequisites: Docker with Compose, an HTTPS reverse proxy, and credentials for your selected document storage. The proxy must route your public URL to `127.0.0.1:3000` on the Docker host. See [deployment instructions](docs/deployment.md) for the proxy configuration and Docker Desktop details.

For startup, storage, SQLite, and container troubleshooting, see the [debugging guide](docs/debugging.md). The quickest health report is `docker compose exec web python manage.py doctor`; add `--storage` to verify the provider with a disposable file.

```sh
docker compose run --build --rm --service-ports setup
```

The Python installer asks for:

1. The public HTTPS URL.
2. The first administrator's username, display name, and password.
3. The first mountpoint’s provider and connection settings. It is mounted at `/`.

Setup tests create/read/update/delete access before registering the administrator and completing installation. Google Drive and OneDrive guide you through browser authorization using your own OAuth application credentials. The temporary setup callback uses the same proxy and port as the application.

```sh
docker compose up -d web
```

Open **`https://your-wiki-host/login/`** explicitly to sign in. Opening protected pages without a session returns HTTP 500, as required; it does not redirect to login. There are no default accounts, sample documents, or automatic localhost sessions.

If setup fails, run it again. Completed installations cannot be overwritten by setup. Existing prototype data is left untouched and is not automatically migrated.

## Filesystem mountpoints

Choose the root provider during installation; add further mounts from **Menu → Mountpoints**:

| Provider | Connection |
| --- | --- |
| Local | Persistent Docker `documents` volume |
| Google Drive | Guided OAuth authorization and application-created folder |
| OneDrive | Guided OAuth authorization and dedicated folder |
| GitHub | Repository, existing writable branch, path prefix, fine-grained token |
| SMB | Server, share, existing directory, username/password, optional domain |
| SFTP | Host, existing absolute directory, username/password or key, verified SSH host key |

All six providers have direct Python adapters. No remote filesystem mount is required. See [provider setup](docs/storage.md) for credentials, OAuth scopes, and configuration examples.

The wiki manages only files created or imported through it. It does not discover pre-existing provider files or synchronize external changes. New saves and moves write into the provider directory tree; uniquely named revisions prevent collisions. SQLite stores current references and permissions locally, even when documents live remotely. On upgrade, startup copies current legacy revisions into their directory paths and retains older references for recovery. If a provider is offline, run `docker compose exec web python manage.py sync_storage_tree` after reconnecting.

Visual editors merge live changes and acknowledge them after a durable SQLite commit. Provider snapshots synchronize in the background, with a visible local/synced status and automatic retries. Source edits remain exclusive and revision checked. Old revision files remain for recovery; there is no revision-history UI or automatic revision pruning yet.

Deletion removes access immediately and queues the current remote file for deletion. If storage is unavailable, the application retries on the configured synchronization interval. Older revision files are retained. Provider roots stay fixed. Create another mount and move files into it to change providers. See [mountpoint management](docs/mountpoints.md) for nested mounts, Docker bind mounts, credential updates, and migration behavior.

## Permissions and accounts

Documents have an owner, a group, and independent **visible**, **read**, and **write** flags for owner/group/everyone. The applicable rule is owner first, otherwise matching group, otherwise everyone. Rules do not accumulate. Everyone means other signed-in users. Administrators bypass document permissions.

- Visible permits discovery and direct addressing.
- Read permits opening and exporting a visible document.
- Write permits modifying or deleting a visible document. The editor also requires read access.

Owners and administrators manage document permissions. Nested directories inherit owner/group/everyone rules by default, with explicit item overrides. An override can grant access inside a private directory without exposing ancestor names. Stars are shared document metadata.

Every denied protected request returns a generic **HTTP 500**, including anonymous requests, hidden-document requests, and insufficient privileges. Explicit login and invitation routes remain public. Invalid login/invitation attempts also return 500; ordinary form errors return 400, and authenticated requests for nonexistent resources return 404. Public `/health/` returns only readiness.

Use **Members** to create groups, assign membership, disable non-administrator accounts, and grant invitation privileges. To reset a password from the server:

```sh
docker compose exec web python manage.py changepassword USERNAME
```

## Site administration

Only administrators see Site administration in the top-right menu. It provides workspace identity, session lifetime, invitation defaults, login limits, upload limits, synchronization interval, and default document permissions, plus access to members/groups, permissions, invitations, directories, and storage diagnostics. Deployment settings are shown without exposing secrets; credentials remain managed by the installer.

## Invitation-only registration

There is no open registration. Administrators and members explicitly granted invitation privileges can create links from **Invitations**. Links default to seven days and one use; expiration and usage limits are configurable, including reusable links. Links must be copied when created and distributed manually; plaintext tokens are not retained.

Administrators choose which groups each permitted inviter may assign. Invitations cannot grant administrator or invitation-management privileges. Removing an inviter's permission or allowed group invalidates affected outstanding invitations. Revoked, expired, and exhausted links fail with HTTP 500. Simultaneous redemptions cannot exceed the usage limit.

## File support

The left panel displays a collapsible directory tree; file lists show the contents. Drag files from a list or directories from the tree onto a destination, or drop files from your computer to upload. Use the Move links for keyboard and touch navigation. New-directory and file forms accept existing absolute parent paths such as `/Projects/Notes`; `/` means workspace root. Leave initial content blank to create an empty document, table, diagram, or ordinary file.

Upload any file type, including PDFs, images, and ZIPs, up to 5 MB (or the lower configured document limit). Uploads retain their original bytes and filenames, use the same access permissions, and are served as downloads. Use wiki import below when you want an editable document instead.

Import UTF-8 `.md`, `.txt`, `.csv`, `.drawio`, `.xml`, `.canvas`, and native `.wiki.json` files up to 5 MB. Rich documents and spreadsheets use versioned native formats to retain formatting and formulas; original imported revisions are retained. Export native JSON, Markdown, CSV, `.drawio`, or `.canvas` as appropriate.

Rich documents provide font sizes/families, colors, lists, links, tables, images, find/replace, undo/redo, comments, text suggestions, and browser printing. Readers may review; writers accept or reject suggestions. Spreadsheets provide a visual grid, formulas, formatting, multiple sheets, sorting/filtering, and structural editing. Canvas supports editable cards, groups, references, and connectors; draw.io uses the full self-hosted editor. All four support live collaboration. Tables support up to 2,000 rows and 200 columns per sheet, and up to 20 sheets. Canvas limits remain 1,000 nodes and 5,000 edges.

Word/Excel import/export and formatting suggestions are deferred. Markdown/CSV exports lose unsupported formatting; CSV exports the first sheet’s values. Portable `.wiki.zip` bundles include reviews, collaboration state, and uploaded images (up to 50 MB). Plain Markdown links still require wiki access. Older revisions remain in their original provider paths for recovery.

## Development and checks

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python install.py --allow-http
npm ci --ignore-scripts
npm run build
.venv/bin/python docker/fetch_drawio.py
.venv/bin/python manage.py collectstatic --noinput
.venv/bin/python -m docker.start
```

For local development, give the installer `http://localhost:8000`; Uvicorn listens on port 8000 outside Docker. `--allow-http` is only for trusted local testing. Database and files default to `instance/`, not the old prototype's `data/`.

```sh
.venv/bin/python -m pytest -q
.venv/bin/python -m playwright install chromium
RUN_BROWSER=1 .venv/bin/python -m pytest tests/browser -q
```

The test suite covers access denial, sessions, invitations, concurrency, storage contracts, previews, installation/retry, and SQLite backups. Browser tests and live provider tests are opt-in. CI runs browser tests plus Docker deployment and real SMB/SFTP fixtures. For Docker acceptance locally:

```sh
.venv/bin/python tests/run_container_checks.py
```

This command uses temporary Compose projects and deletes only their test volumes on exit. Live cloud tests require your own dedicated test credentials; see [provider setup](docs/storage.md).

## Security audit and deployment limits

The application was reviewed for authentication, authorization, CSRF, path traversal, upload handling, archive extraction, storage credential handling, and client-side injection. The reviewed flows enforce invitation-only registration, Django password hashing and CSRF protection, signed sessions, permission checks before document and attachment access, bounded uploads, safe ZIP member names, defused XML parsing, and encrypted provider credentials.

Treat these deployment requirements as security controls:

- Put an HTTPS reverse proxy in front of the container. Do not publish port 8000 or the Compose port directly to the internet. `--allow-http` is for local development only; HTTP sessions do not have the `Secure` cookie flag.
- Keep the `database`, `secrets`, and `documents` volumes private and back them up separately. Never commit `runtime.json`, `encryption.key`, OAuth tokens, SSH keys, or provider passwords; the repository ignores their normal local paths.
- Use a dedicated OAuth app, GitHub token, SMB account, or SFTP account with only the required repository/share permissions. Rotate credentials after a suspected leak and reconnect the mount.
- The bundled draw.io editor requires a broader script policy (`unsafe-inline`/`unsafe-eval`) for its upstream application. Keep it same-origin and do not load untrusted draw.io bundles into the image. User document previews are sanitized separately and do not use that policy.
- Login attempts are throttled, but this is a single-process SQLite deployment. Put rate limiting and request-size limits at the reverse proxy if the service is internet-facing, and keep the container bound to loopback as shown in `compose.yaml`.

The audit was source-based and backed by the automated test suite; it is not a substitute for a penetration test of a deployed instance or a review of provider account permissions.
