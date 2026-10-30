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
logging, database/auth/ACL, React SSR and worker are subsequent implementation
steps; this server is not a production replacement yet.

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
