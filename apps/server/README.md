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

The development server binds only to `127.0.0.1:3100`:

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

The caller owns the database lifetime. The development entrypoint does not
open/import any database automatically. There is no initial administrator,
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

These internal APIs are exposed by the opt-in routes below. Resumable uploads,
recovery downloads and office converters are still pending. The 4 GiB storage
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
asset digests are not standalone access capabilities. Recovery-copy download,
resumable transport remain pending; worker execution is a separate process.

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
PDF.js viewer and its annotations/forms workflow. Office conversion, native
Yourwiki document formats, Canvas/drawio, embedded resources/fonts and large
file acceptance remain pending. The worker does not establish 4 GiB office
viewing/editing or the page performance target.
