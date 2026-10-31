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
