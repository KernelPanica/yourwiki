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
