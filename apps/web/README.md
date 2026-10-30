# Yourwiki React client

Opt-in replacement client; the Django frontend and production deployment are
unchanged. Requires the new server's explicit database/storage configuration.

```sh
npm --prefix apps/web ci --ignore-scripts
npm --prefix apps/web run typecheck
npm --prefix apps/web test
npm --prefix apps/web run build
```

React/ReactDOM19.3.1, esbuild0.28.2 and TypeScript7.0.2 are pinned in a separate
lockfile. Initial npm12 peer resolution stalled in this environment; explicit
compatible React peer versions were verified, then `--legacy-peer-deps` generated
the lock. A subsequent ordinary offline `npm ci --ignore-scripts` succeeded.

Build output is ignored under dist. Point buildApp.webRoot at its absolute path.
Hashed JS/CSS and the local Inter variable font use one-year immutable public
cache, gzip/Brotli variants and retained assets from earlier builds. Static HTML
and authenticated API/private assets remain no-store. Older manifest-listed
chunks are intentionally retained so an open tab survives a client update;
production retention/rollback orchestration remains deployment work. Restart
the opt-in server to activate a new HTML/asset manifest. Third-party license
texts are included in dist/licenses.

Implemented viewing path:

- Cookie-authenticated login/logout, cross-tab auth invalidation and account groups/role (no technical storage
  fields), browser language ru/en/es.
- ACL-filtered paginated published-document catalog; draft visibility unchanged.
- Persistent navigation shell and previously visited catalog/filter. Current
  document requests abort on navigation; private state unmounts on logout.
- Combined document/manifest/presentation-index API to avoid sequential metadata
  round trips. HTML documents/tables render in a script-disabled sandbox iframe.
- Lazy presentation component: main slide on the right, scrollable thumbnails on
  the left, previous/next/Home/End/arrow keys and lazy thumbnails. No animations.
- Mobile layout, 44px buttons, visible keyboard focus and local cached font.

This is not feature parity yet. PDF.js annotations/forms/recovery, editing and
provider session popups, folder tree/upload GUI, Recent, dashboard/admin/account
mutations/avatar/animation preferences, live ACL/update events and other approved
modules still need integration. Existing functionality remains in the old
runtime until migration acceptance. The catalog held in memory is not a live
subscription; API reads and downloads always recheck current permissions.

The initial main script is approximately66KB Brotli plus small shared chunks;
presentation code is split out. This is a build measurement, not a claim of
500ms page readiness. Full cold/warm timings on Redmi Note12T over internet,
low-memory profiling and mixed Collabora load remain required.
