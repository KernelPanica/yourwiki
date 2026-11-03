# Yourwiki TypeScript backend

Isolated foundation of the replacement runtime. The existing Django app,
Dockerfile, Compose services and editor build remain unchanged.

Requires Node >=24.12.0. From the repository root:

```sh
npm --prefix apps/server ci --ignore-scripts
npm --prefix apps/server test
npm --prefix apps/server run typecheck
npm --prefix apps/server start
```

Without arguments, the development server binds only to `127.0.0.1:3100`:

- `GET /health/`: process liveness; does not claim workspace readiness.
- `GET /ready/`: returns 503 until local migrations/storage checks are wired in.
- Other routes: structured 404. No document API, login or workspace is exposed.

The app factory accepts an asynchronous local readiness check. Cloud API calls
must not be used for readiness. JSON requests currently have a 1 MiB cap;
streaming file uploads will have an independent route-specific policy. This
cap is not the planned 4 GB file-upload limit.

Errors contain server-generated request IDs and explicit recovery metadata.
Unknown outcomes never imply a safe retry. Exception messages, raw parser
inputs and request URLs are not returned in error bodies. Structured production
logging and React SSR remain subsequent implementation steps; this server is not a production replacement yet.

## Explicit configured workspace

For an already initialized **v2 workspace**, the same entrypoint serves the
built React app, login, document/history APIs and central Google settings:

```sh
npm --prefix apps/web run build
npm --prefix apps/server start -- /srv/yourwiki-v2/workspace.sqlite3 /srv/yourwiki-v2/storage /srv/yourwiki-v2/secret.key https://wiki.example.com /srv/yourwiki/apps/web/dist --port 3100
```

The five positional arguments are absolute database/storage/key paths, the public
origin, and the absolute built-web path; `--port` is optional (default3100).
The listener remains `127.0.0.1`, suitable for the configured reverse proxy.
Public origin must be HTTPS, except loopback HTTP during local development.
Use exactly the public origin in the OAuth client's callback URL.

This mode requires an existing marked v2 database, storage directory, built
manifest/index, and existing0600 installation key. It does not create an account,
key or workspace and does not discover/import a Django database. Foreign/empty
or missing databases, invalid frontend, unsafe key and connection decryption
failure refuse startup with a fixed error. Migrations/checksums still use the
normal v2 database opener. Keep a backup before upgrading a workspace.

`/ready/` becomes200 after local initialization; it does not prove Google
availability or source delivery. Google settings are advertised only to current
Gigaadmins. Configuration/authorization work independently of source workers:
Google source writes, native edit operations, grants/discovery/lifecycle and
real-account acceptance are still incomplete. Preview and provider workers
remain separate explicitly started processes; this entrypoint does not spawn
workers or configure Collabora. The configured app owns its database/key and
releases them after services drain on shutdown.

Docker/Compose still starts Django. This opt-in command is not a production
cutover or a finished installer/data migration.

## Database, identity and access core

`openDatabase(path)` creates a separate versioned SQLite database. A nonempty
legacy/foreign database is refused before migrations or journal-mode changes.
Applied SQL checksums and future schema versions are checked on reopen. The
new database uses WAL, foreign keys and a global ACL epoch; changes from server
or worker invalidate cached access decisions atomically.

The app factory can opt into identity routes:

```ts
const db = openDatabase('/private/new-yourwiki-v2.sqlite3');
const app = buildApp({ database: db, publicUrl: 'https://wiki.example.com' });
```

The caller of `buildApp` owns the database lifetime. `openConfiguredApp` owns
its explicitly supplied workspace. The entrypoint never discovers/imports a
database automatically. There is no initial administrator,
installer or migration importer yet; do not switch an existing installation.
Readiness stays false until a separate local workspace check is supplied.

Opt-in routes:

- `POST /api/auth/login`: JSON username/password, exact Origin required;
  returns session-bound CSRF capability and expiry, sets HttpOnly/Strict cookie.
- `GET /api/account`: cookie-authenticated, sanitised user/groups and CSRF.
- `POST /api/auth/logout`: cookie, exact Origin and `X-CSRF-Token` required.

HTTPS uses Secure cookies. Password change or account disable invalidates old
sessions; credentials are rechecked after asynchronous KDF work. Rate limits
are persisted and reserved before password verification, with account and peer
IP quotas. Forwarded IP headers are not trusted by default.

Current Django-compatible password algorithms: PBKDF2-SHA256, PBKDF2-SHA1 and
scrypt, verified with genuine Django-generated Unicode fixtures. Other or
excessive-cost encodings fail closed. The eventual importer must report/block
unsupported credentials rather than reset passwords or silently lock users out.

`AccessService` preserves owner/group/everyone, personal deny, multiple groups,
inheritance exceptions and independent export bans. Cache size is bounded;
reads inside transactions bypass it to avoid stale entries after rollback.
This core does not yet expose document/admin mutations or the React UI.

## Storage and publication core

`BlobStore` streams originals to private immutable SHA-256 blobs, enforces byte
limits before writes, supports byte ranges and cleans temporary payloads on
failure. A source iterator's stalled cleanup cannot hold our staging file open.

`JobQueue` persists deduplicated work with bounded retries, expiring leases and
fenced acknowledgements. Reclaimed work signals an uncertain previous outcome;
future cloud handlers must reconcile before repeating provider mutations.

`DocumentService` commits local revisions and preview jobs together. Publication
verifies source and all artifacts, then atomically moves the published pointer,
records an event and acknowledges the job. Previous previews remain available
while replacements prepare; obsolete workers cannot replace newer requests.
Published manifest receipts survive converter changes. Unpublished files are
restricted to owners/admins. Concurrent revision or ACL changes reject saves
and retain accepted bytes as recovery copies.

These internal APIs are exposed by the opt-in routes below. Resumable HTTP uploads and initial office converters are implemented below;
recovery downloads remain pending. The 4 GiB storage
limit does not establish feasibility of 4 GiB office viewing/editing.

## Opt-in document HTTP transport

Pass `storage: await BlobStore.open('/private/yourwiki-v2')` alongside the
explicit database and public URL to enable these authenticated local routes:

- `GET /api/documents/:id`: published metadata only.
- `GET /api/documents/:id/processing`: owner/admin draft status or readable
  published-document preparation status.
- `GET /api/documents/:id/previews/:manifestDigest`: published manifest receipt.
- `GET /api/documents/:id/previews/:manifestDigest/assets/:name`: referenced
  asset only, sandbox CSP and current read permissions.
- `GET /api/documents/:id/content`: published original as attachment, export
  permission required, single byte ranges supported.
- `POST /api/documents?title=...&format=...&groupId=...` (or `parentId=...`):
  raw `application/octet-stream` upload, returns 201 with document/revision/job.
- `PUT /api/documents/:id/content?baseRevision=...`: raw streamed save, returns
  202 while replacement preview prepares. Stale revisions return 409 with
  recovery actions; accepted conflicting bytes have a recovery operation ID.

Mutations require session cookie, exact Origin and session-bound X-CSRF-Token
before body parsing. `maxFileBytes` configures the independent streaming limit
(default 4 GiB); this bypasses the JSON parser's 1 MiB cap. Aborted uploads clean
staging without committing partial revisions. Responses remain private/no-store;
asset digests are not standalone access capabilities. Recovery-copy download remains pending; resumable transport is described below; worker execution is a separate process.

## Preview worker

Run against an explicitly initialized **new** workspace database and storage:

```sh
npm --prefix apps/server run worker -- /absolute/new-yourwiki-v2.sqlite3 /absolute/private-storage
```

The CLI refuses missing paths and the database core refuses foreign/legacy
schemas. It does not discover/import users or enable the API automatically.
Run under a process supervisor that cleans up child processes on forced exit.
SIGINT/SIGTERM cancels active conversion, leaves retryable work and releases
the shared preview slot. Expired leases recover work after abrupt termination.
A durable slot serializes conversion across worker instances; provider jobs
are never claimed by this worker.

Current converter version `preview-v1` supports Markdown (`md`, `markdown`),
UTF-8 text (`txt`, `text`) and PDF passthrough. Text rendering runs in a child
Node process with a 256 MiB V8 heap cap, 30 second timeout, 16 MiB input and
64 MiB HTML output budgets. These defaults are explicit resource guards;
exceeding them reports `PREVIEW_TOO_COMPLEX`. This is process separation,
not an OS security sandbox. No secrets from the parent environment are passed.
Raw Markdown HTML is disabled, and remote images are rendered as alt text;
attachment image resolution remains pending. Parser reference:
[markdown-it documentation](https://github.com/markdown-it/markdown-it).

PDF header checking is preliminary; bytes remain unchanged for the future
PDF.js viewer and its annotations/forms workflow. Initial office conversion is described below. Native Yourwiki document formats,
Canvas/drawio, complete embedded-resource/font fidelity and large-file acceptance
remain pending. The worker does not establish 4 GiB office
viewing/editing or the page performance target.

## Resumable uploads

Authenticated routes (mutations require the same Origin/CSRF protection):

- `POST /api/uploads`: JSON `{mode:"create", title, format, groupId, size}`
  (or `parentId`) or `{mode:"save", documentId, baseRevision, size}`. Returns
  `id`, `offset`, `chunkBytes`, `expiresAt` and state.
- `GET /api/uploads/:id`: owner-only durable progress and completion receipt.
- `PATCH /api/uploads/:id?offset=N`: raw `application/octet-stream`. Send exactly
  `min(chunkBytes, size-offset)` bytes. Successful offset is durable; after a
  disconnect query status and resend the unconfirmed part. Replaying the same
  bytes at a committed boundary succeeds; different bytes return 409.
- `POST /api/uploads/:id/finish`: streams assembly and commits the document,
  preview job and completion receipt atomically. After lost ACK, retry returns
  the same receipt. Concurrent append/finish returns 423; query status/retry.
- `DELETE /api/uploads/:id`: cancels an unfinished upload and cleans its parts.

Default file limit is 4 GiB, chunks 8 MiB, pending reservation quota 8 GiB,
expiry 24 hours; up to 3 active uploads per user, 45 uncleaned reservations and
4096 parts per upload. Chunk size is persisted per upload, so a configuration
change does not alter an in-progress protocol. Parts use private separate
namespaces, checksum verification and fsynced directory entries. No whole-file
buffer is used. Chunk acceptance and assembly have renewable leases and hard
operation deadlines (5 minutes/chunk, 1 hour/assembly).

`maxPendingUploadBytes` and `uploadChunkBytes` configure the opt-in app factory.
Reservations remain charged until temporary storage is cleaned; cleanup runs
on startup and each minute, and resumes after failure. Account/ACL/base revision
are rechecked on accepted chunks and final commit. Stale saves retain their
upload parts for recovery until expiry/cancellation; recovery download UI is
still pending. Disk capacity must also cover the permanent assembled copy,
existing files/history, and filesystem overhead; a total workspace quota and
free-space monitoring remain to be connected before production. These tests
do not establish 4 GiB office rendering/editing or end-to-end page latency.

## Native office previews (Linux)

The preview registry also routes Writer formats (DOC/DOCX/ODT/RTF and related
templates), Calc formats (XLS/XLSX/ODS/CSV/TSV and related templates) and Impress
formats (PPT/PPTX/ODP and related templates) to a native LibreOffice engine.
Tests currently prove small DOCX, XLSX, ODS and PPTX fixtures; other registered
formats and complex fidelity still require corpus acceptance.

Required: Linux user namespaces, `/usr/bin/bwrap`, `/usr/bin/prlimit`, tar,
pdfinfo/pdftoppm, system fonts and a LibreOffice installation (default
`/usr/lib/libreoffice`, containing `program/soffice`). Optional explicit root:

```sh
npm --prefix apps/server run worker -- /absolute/new.sqlite3 /absolute/storage --office-root /absolute/libreoffice
YOURWIKI_TEST_OFFICE_ROOT=/absolute/libreoffice npm --prefix apps/server test
```

No host-execution fallback exists if sandbox setup is unavailable. The sandbox
has no network, host HOME or general host filesystem; only the selected original
is mounted readonly alongside system libraries/fonts and the engine. It uses a
fresh macro-disabled profile, PID namespace/die-with-parent and bounded tmpfs
(64 MiB output, 64 MiB scratch, 32 MiB profile), CPU/file-size limits and a
120-second wall timeout. Native processes are killed on cancellation. Worker
Node heap is capped at 384 MiB by the npm worker command. The native virtual
address-space ceiling is 8 GiB; **this is not a resident-memory limit**. A hard
RSS/cgroup limit and measurements alongside Collabora on target hardware remain
release work. The bundled development LibreOffice is not a production version
pin; reproducible worker packaging and font distribution remain pending.

Writer/Calc output is sanitized HTML with cell spans, basic inline formatting,
calculated results and authenticated local raster images. Scripts, forms,
remote image loads and unsafe CSS are removed. Sandbox `allow-same-origin`
permits authenticated nested images/fonts; scripts remain blocked by CSP and
are not granted sandbox permission. Export prevention cannot make visible
content impossible to copy.

Presentations export to PDF internally, then to ordered 1600px PNG slides and
240px thumbnails (default maximum 200 slides); the intermediate PDF is not
published. The primary JSON artifact contains `{schemaVersion:1, slides:[
{index,image,thumbnail}]}` and references named artifacts. The React main-slide/
left-thumbnail GUI is still pending. Engine filter reference:
[LibreOffice conversion filters](https://help.libreoffice.org/latest/en-US/text/shared/guide/convertfilters.html).

## React client (explicit opt-in)

Build `apps/web`, then pass `webRoot: '/absolute/yourwiki/apps/web/dist'` to
`buildApp` alongside database/storage/publicUrl. No automatic production switch.
The root, `/documents/:id` and `/account` serve a static public shell with CSP;
only manifest-listed hashed code/font assets are public/cacheable. Private
metadata/preview bytes continue to require the session and current ACL.

`GET /api/documents?after=...&limit=50` returns published accessible metadata and
write/export capabilities. Scanning is bounded at200 candidates; `nextCursor`
may be present even when a filtered page is empty. `GET /api/documents/:id/view`
combines metadata, preview manifest and (for presentations) the small index in
one authorized local response. Neither endpoint calls cloud providers.

React implements the first read path, not editor/provider/PDF.js parity. The
old runtime remains authoritative until the remaining acceptance gates pass.

PDF persistence APIs (opt-in TypeScript runtime): `GET /api/documents/:id/pdf`
returns current base/layer revisions and whether the saved layer belongs to an older original.
`PUT /api/documents/:id/pdf/layer?baseRevision=N&layerRevision=M` streams an
`application/octet-stream` derived PDF with the normal session, Origin and CSRF checks.
Replacing an older-base layer additionally requires `replaceStaleLayer=true` and exact
current revisions. `GET .../pdf/layers/:revision` streams an immutable saved layer with
byte ranges and current read permission. Conflicts return an operation ID;
`GET .../pdf/recovery/:operationId` permits downloading that author's retained copy
only while current read/export permissions allow it. Responses remain private/no-store.
These endpoints do not overwrite the original and do not yet activate the React PDF editor.

Local live invalidation: `GET /api/changes` opens a session-authenticated SSE stream.
It accepts no query parameters or URL tokens; a supplied Origin must match the
configured public origin. Signals are `ready`, `access`, `documents` (currently
readable IDs only; an empty ID list means revalidate all), and `session-expired`
followed by EOF. Keep-alive comments are emitted on quiet connections. Clients
must refresh on ready/reconnect: this is not a replay feed or a source of document
contents, and signal receipt never grants read/write access.

One shared 250ms database poll runs only while connected. It reads bounded event
batches, coalesces IDs and checks sessions/current ACL before delivery. Limits are
4 connections per user and 128 per process. Slow readers are disconnected rather
than retaining unbounded buffers; application shutdown closes streams. Transient
read failures disconnect streams while allowing a fresh subscription after recovery.
No provider is called. The React client is not wired to this endpoint yet: dirty
editor/session-switch protections are required before enabling client invalidation.
