# Global Version History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, tests first; whole-branch review at the end of the full rewrite.

**Goal:** Preserve the global administrative history toggle and full historical-byte access/restore without weakening technical revision/conflict protection.

**Architecture:** Append optional archive receipts referencing existing immutable blobs. Central source commit and PDF layer commit capture the previous effective bytes atomically with accepted changes; every ingestion/office/journal path uses those commits. History is off by default, disabling adds no snapshots and removes none. Source revisions/PDF layers remain technical state regardless of the flag. Separate global settings, history read/restore, compatibility import/export and UI tasks keep external/provider delivery distinct from local commit.

**Tech Stack:** Existing TypeScript/Fastify/React/CSS/SQLite/BlobStore; no new runtime dependencies.

**Spec:** docs/superpowers/specs/2026-10-30-yourwiki-rewrite-design.md (history, saves, UI, migration); F06 acceptance; wiki/file_history.py and wiki/version_views.py are the legacy contract.

## Global Constraints

- Full rewrite goal remains active; production legacy/CSP/office write gate unchanged.
- Both admin roles may change the global flag; ordinary users cannot. Current authentication/CSRF/Origin and role are rechecked locally. No per-file override.
- Off by default, no retroactive archive creation; previous archives remain readable when off. Technical revisions always advance for accepted saves.
- Changed saves only; failed/conflicting/denied saves create no archive entry. Lost-ACK journal replay adds no duplicate snapshot.
- No unbounded binary/base64 buffering on the HTTP process. Exact private blob references are internal, never arbitrary digest authority.
- History quota failure cancels original commit with retained incoming recovery and a meaningful error; no automatic rotation/deletion.
- Legacy history JSON v1 continues through explicit compatible streaming import/export. New receipts are a versioned independent representation, not a claim that the legacy sidecar was migrated.
- User-visible restore requires current write rights, exact source/layer baseline, integrity/format checks and no active editor/pending session. Old bytes are preserved exactly, no silent re-encoding or format switch.
- No provider success claim from local restore; provider delivery/grants/import remain full-rewrite acceptance requirements.

## Review Focus

1. Toggle or role changes during upload/validation: use committed global flag/current role and final save transaction (Task1 tests).
2. Transaction fails after archiving or journal acknowledgement is lost: no phantom/duplicate history and no current-data loss (Task1 tests).
3. PDF first annotation, stale-layer replacement and original source change: record the right previous base/layer, never silently merge incompatible originals (Tasks1/2 tests).
4. Removed export/read permission during integrity scan or stream: no new authorized download, no public digest route (Task2 tests).
5. Admin lost ACK/concurrent toggles/account switch: read back authoritative state; do not replay a writing request automatically or restore stale UI (Task3 tests).

## Task1: Atomic archive capture and administrative settings API

**Files:** create apps/server/src/document-errors.ts, history-capture.ts, history-settings.ts, history-settings-routes.ts and test/history.test.ts; modify schema.ts, documents.ts, pdf-layers.ts, app.ts and error mappings in document/upload/office routes; append migration test.

**Interfaces:** retain DocumentError re-export from documents.ts. `captureSourceHistory(db,documentId,userId,nextDigest,now)` and `capturePdfHistory(db,documentId,userId,nextDigest,now)` run only within an existing transaction and use current global policy. `HistorySettings(db,{clock?}).read(userId)` / `.update(userId,{enabled:boolean,baseRevision:number})` return `{enabled,revision,byteLimit,entryLimit}`. GET/PUT `/api/admin/history-settings`, max1KiB JSON PUT with strict types/keys, Origin+CSRF, admin role, optimistic settings revision. Repeating the current value with its current revision is a no-op, stale revision is CONFLICT.

- [x] Write RED tests: default-off technical saves, on/off/on across multiple files, changed vs identical bytes, PDF initial-original and previous-layer capture, toggle during streaming, budget exhaustion with retained recovery, final-transaction rollback, journal replay, office save, member/role/CSRF denial, concurrent admins/strict body/lost ACK read-back, SQLite reopen and schema19→20 preserving all prior checksums.
- [x] Append migration20: history policy enabled0/settings revision0; immutable metadata archive receipts with source/PDF identity and indexed document/id lookup; indexed per-document byte/count usage maintained by SQL triggers; settings audit. Default per-document raw archive budget40GiB (10×approved4GiB file ceiling) and100000 entries; no automatic expiry. Budget is version2 raw referenced-byte accounting, explicitly different from legacy v1 JSON/base64 accounting.
- [x] Extract unchanged DocumentError to avoid an import cycle; call capture before source/PDF replacement inside existing commits. Existing history references are not backfilled. Capture PDF original as layer0 before first real annotation; otherwise previous layer with its original source base. Skip identical digest; retain title/format and saving author/date as snapshot metadata.
- [x] Wire admin API and HISTORY_LIMIT409/recovery actions through source/PDF/upload/WOPI errors. Run targeted/full server native suite and TypeScript, diff gates, ledger and commit.

## Task2: History read, integrity, preview and restore APIs; legacy archive compatibility

**Files:** create focused history-read/restore/compatibility modules, routes and tests; register in app.ts. Do not expose blob digests as independent download authority.

- [ ] Add bounded current-ACL metadata pages (default50 max200, descending immutable history ID), verified exact-byte downloads/ranges, safe prepared historical preview with no write capability. Recheck authentication/read/export after IO and during streams. History remains visible when disabled.
- [ ] Restore via durable idempotent operation and exact source/layer baseline; verify digest and native format, honor office/pending editor fences, preserve both incoming recovery and replaced current content according to global policy; report local/provider states separately. Test two restores/writers, corrupt bytes, stale original/layer, missing formats, old author deletion, access revocation mid-IO, lost ACK/restart and4GiB streaming limits.
- [ ] Stream legacy `{format:'yourwiki-history',version:1,entries:[...]}` compatible JSON/base64 export; bounded streaming import with digest/identity/date validation, retained source metadata and idempotent migration receipts. Verify byte-exact legacy corpus and malformed/oversized archive refusal. Preserve stable entry identity despite imported duplicate revisions.
- [ ] Full relevant/native suites, TypeScript, ledger and commit. F06 stays incomplete until compatibility/restore/preview are verified.

## Task3: Global settings and history React UI

**Files:** lazy settings/history components and controllers, i18n/CSS, App.tsx routing; pure unit and real-HTTP browser tests.

- [ ] Implement admin-only settings route and native accessible checkbox for all files, authoritative GET/PUT CAS, pending/saved/conflict/unknown read-back and explicit retry, no automatic POST/PUT replay; account fences ignore late replies. RU/EN/ES, no added editor dependency in shell.
- [ ] Implement bounded lazy history panel, dates/authors/revisions, safe historical previews/download and explicit restore confirmation. Disable actions according to current permissions; dirty current editors stay mounted through any warning; no exit save. Explain budget/full-history failure and show appropriate download/archive/disable actions.
- [ ] Tests RED→GREEN and real HTTP Chromium: global on/off affects two files, member cannot toggle, retained archive when off, history view/download/restore and conflict/recovery, unknown/lost-ACK settings, account switch, mobile/keyboard. Native4GiB/CODE/Safari/provider acceptance remain separate.
- [ ] Full web/server verification appropriate to final change, production build, browser regressions, ledger/diff gates and commit; continue remaining approved roadmap.


Task1 evidence (2026-10-31): server344/344 including the native office corpus; TypeScript passed. New history service/API and migration tests were RED for missing module/schema; the office retained-error regression was RED (OFFICE_SAVE_INTERRUPTED instead of HISTORY_LIMIT), then GREEN after retaining known DocumentError codes at the ingress boundary. A separate check compares all19 previously committed migration SQL strings against HEAD and confirms exact preservation, not just fixture-generated checksums. No new UI, history read/preview/restore or legacy sidecar import/export is claimed by Task1.

Ruling: archive receipts are independent of technical-version foreign keys/unique revision constraints — the legacy archive can contain duplicated/reused revision numbers and migration must preserve those entries rather than invent technical revisions — cost: Task2's importer must validate every receipt's document/digest/identity explicitly. Locally captured receipts still derive from the locked current source/layer row. SQL prevents mutation of archive identity, digest, size and archival metadata; nullable actor identity can follow eventual account purge, preserving its captured label. Usage updates/deletion are transactional and indexed. No history purge endpoint is introduced.

Ruling: new archive budgets count raw referenced bytes (40GiB/default per document,100000 entries), not v1 serialized JSON/base64 bytes — immutable blob references eliminate full sidecar rewriting and bound metadata without bulk data copies — cost: the budget unit differs from legacy JSON accounting and must be explained in the UI/manifest/import policy. No automatic rotation or lower file-size ceiling. Existing legacy sidecars are untouched; compatibility remains Task2.

Task2 read/integrity execution detail (2026-10-31): implement `HistoryRead(db,store)` with `list(userId,documentId,{after?,limit?})`, `entry(userId,documentId,entryId)` and `download(userId,documentId,entryId,{signal?,authorize?,range?}) -> Promise<{entry,bytes:AsyncGenerator<Uint8Array>}>`. Metadata exposes schemaVersion2, source/layer revision, captured title/format/author/date/size/SHA256 and current read/write/export context; default50/max200 descending immutable ID pages. Unknown/coerced query fields, unsafe/nonpositive entry IDs and cross-document receipts are rejected. Only currently published readable documents can expose historical metadata, regardless of whether history is enabled.

`HistoryIntegrity` uses the existing cross-process worker_slots table for one globally leased streaming SHA256 verification at a time,30s lease/10s renewal and1h verification deadline, with250ms authorization/cancellation checks. Busy requests return explicit503/HISTORY_BUSY, no hidden automatic retry. Expired/lost leases, interrupted requests, shutdown and IO errors cannot produce a verified receipt. This protects capacity; it is not4GiB/performance acceptance. No new schema or cached verification proof in this substep.

GET `/api/documents/:id/history` and `/api/documents/:id/history/:entryId`; GET `/api/documents/:id/history/:entryId/content` requires current export as well as read, verifies whole immutable bytes before responding, supports exact/suffix single ranges, validates ranges before expensive verification and sends attachment/octet-stream/no-store/nosniff/sandbox headers. It rechecks the issuing parent session and current document/entry binding after async IO and before each yielded chunk; already authorized socket/client buffers cannot be recalled. Cancellation closes reads/leases. Tokens, provider references and arbitrary digest/path lookups are not exposed. Preview/restore/compatibility and all GUI acceptance remain the later parts of Task2/Task3, so neither Task2 nor F06 may be checked complete after this substep.

Tests first: user/group/giga isolation, global history off/archive retained, source vs PDF metadata, old titles and duplicate revisions with distinct receipt IDs, bounded keysets under a concurrent insert, invalid query/IDs and unpublished/trash/revoked documents; exact bytes/ranges/empty files and native HTTP response headers; corrupt/missing bytes; current read/export/account/session revocation during verification and stream; abort/deadline/shutdown/lease loss and simultaneous verification across two database connections. Use real BlobStore/SQLite/HTTP; controlled delayed IO belongs in test wrappers, not product hooks.


Task2 read/integrity substep evidence (2026-10-31): HistoryRead/HistoryIntegrity and authenticated scoped metadata/content routes are implemented. Full server367/367 (23 new read/integrity/real-HTTP checks plus prior344), TypeScript passed. Missing modules/routes were observed RED, then GREEN. All20 committed migrations are unchanged. No frontend/browser assets or production/office/CSP flags changed. Task2's checkbox remains open because historical preview, restore and legacy JSON compatibility remain unimplemented.

Ruling: use one shared leased integrity pass, with immediate HISTORY_BUSY503 and safe explicit read retry, rather than queueing many giant hashes on the HTTP process — preserves bounded disk/hash concurrency on the small target host and keeps metadata usable — cost: simultaneous archive-download starts may require retry. The slot covers integrity IO, not the subsequent authorized byte transfer. Verification reads the whole immutable blob even for a partial download, so corruption outside the range is rejected. Historical PDF rendering must use the planned prepared-view/manifest route rather than repeatedly invoke this attachment endpoint for its range requests. The hash deadline/cancellation signal is cooperative with local BlobStore IO; no claim of cancelling an uninterruptible kernel operation or protecting against a privileged operator rewriting private blobs after verification.

Native HTTP checks verify disconnected verification release, parent-session expiry before response, midstream session revocation with an incomplete original-length response, bounded metadata while hashing is busy, correct private attachment/CSP/CORP/no-sniff headers, exact/suffix/empty ranges, whole-file checksum refusal, Unicode filename normalization and safe opaque IO errors. Unit checks additionally cover current publication/ACL/trash/export/giga behavior, preserved title/author/off-state archives, duplicate revisions and insertion-stable bounded keysets, PDF layer0 identity, two SQLite connections sharing a slot, expiry/deadline/lease replacement/shutdown, an idle verifier stopped by permission change and unread stream cleanup after post-verification revocation. IDs/digests never grant access independently.

One initial missing-route RED harness waited indefinitely for verification that404 could not start; only its confirmed owned runner/child were terminated. The test now bounds that start wait and produced a clean RED before route implementation. A compile failure for String.toWellFormed under the existing ES2023 target was fixed with bounded UTF8 normalization; the project target/runtime dependencies were not broadened. No actual CODE, browser GUI, legacy import/restore,4GiB or500ms/load acceptance is claimed.
