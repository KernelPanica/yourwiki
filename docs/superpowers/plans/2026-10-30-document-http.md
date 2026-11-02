# Document HTTP implementation plan

Продолжение утверждённой архитектуры, без переключения production.

- [x] RED→GREEN HTTP tests: authenticated publication metadata, hidden drafts, versioned manifests/assets, current ACL on every request, export bans, bounded byte ranges.
- [x] Shared session-cookie reader; local-only document routes enabled only with explicit database and BlobStore.
- [x] Streaming create/save with exact Origin/CSRF before parsing bytes, independent byte limit, structured conflict/recovery errors. Existing published data remains readable while saves prepare.
- [x] Tests for unauthenticated/CSRF rejection, oversized files and stale revision; no buffering whole originals.
- [x] Server tests/typecheck, independent review, progress ledger and commit.

Routes are a first streaming transport, not the resumable upload protocol. No cloud API in read path. HTML preview assets require a sandbox CSP; manifest receipts constrain asset references. Export restriction is enforced on original downloads; viewed pixels/content cannot be made impossible to copy.
