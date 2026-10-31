# Personal Recent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Steps use checkbox syntax.

**Goal:** Show only the current user's explicitly opened, currently readable documents, newest first, in the React shell.

**Architecture:** Append a user/document visit table to the immutable SQLite migration ledger. A CSRF-protected explicit visit records a real document-page opening; listing, preview refresh, download and provider operations never implicitly record it. Recent reads recheck current ACL/publication and return current titles rather than storing private metadata copies. Keep at most200 distinct documents per user; show50/page with bounded indexed keyset scanning. The UI records once after a document page accepts its view response, without blocking preview or editor startup, and offers an explicit retry on failure.

**Tech Stack:** Existing TypeScript/Fastify/React/CSS/SQLite; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-30-yourwiki-rewrite-design.md` section UI and roadmap item14/F17. Full rewrite remains broader than this plan.

## Global Constraints

- Production remains legacy until full parity; no real cloud mutation or CODE activation.
- ACL is authoritative immediately, including inherited rights and account invalidation; no public/private browser cache mixing.
- Published files only; no preview => no Recent entry. Existing published revision stays eligible while newer preview is pending.
- ru/en/es, native controls, keyboard/modifier links, Android/iOS layout; no animation or dependency additions.
- No page-load performance claims from server timing alone; visit bookkeeping must not gate page readiness.
- Git migration is append-only, checksummed, transactional and compatible with existing data. No invented historical visits.

## Review Focus

1. User change while Recent/visit response is delayed: clear old data and discard late responses (client tests + real browser account switch).
2. ACL/trash/publication changes after a visit: never expose old title/count/metadata (core/HTTP tests + browser live denial).
3. Reopening and simultaneous tabs: one row per document, stable deterministic ordering, bounded retention (core test).
4. Renaming, missing objects and malformed/foreign cursor: current metadata, no alternate user selection, strict cursor validation (HTTP/core tests).
5. Navigation/refresh/retry: do not mark list fetches or SSE refresh as new opens; recording failure must not block preview (controller + real browser tests).

## Task1: Durable visits and authenticated API

**Files:** Create `apps/server/src/recent.ts`, `apps/server/test/recent.test.ts`; modify schema.ts, document-routes.ts, database.test.ts.

**Interfaces:** `RecentDocuments(db, documents, {clock?})`; `record(userId, documentId):void`; `list(userId,{after?,limit?}):{items:(PublishedDocument & {openedAt:number})[],nextCursor:string|null}`. POST `/api/documents/:id/visit` with cookie+Origin+CSRF, empty204; GET `/api/recent?after=&limit=` with cookie only, default50 max200. No user selection. Uses DocumentService.getPublished; route adds the same capabilities as document listing.

- [x] Write tests first: two users (including giga) see only their own visits; no implicit GET/download visits; failed auth/CSRF/draft/denied never records; current titles/ACL/trash; repeat reopen ordering and200 cap; ties/keyset/invalid cursor; FK cleanup and reopen; migration18→19 preserves checksums and prior state and indexed keyset lookup.
- [x] Run targeted tests and observe missing module/table/routes fail.
- [x] Append migration19 user/document foreign keys and `(user_id,opened_at DESC,document_id DESC)` index. Implement synchronous atomic upsert+bounded trim; select at most201 candidates, validate explicit cursor and recheck visibility. Fail invalid input with DocumentError INVALID_REQUEST; never pass caller IDs into SQL identifiers.
- [x] Wire authenticated routes and current capabilities, no-store defaults; run targeted/full server corpus (native tests without Chromium concurrently), server TypeScript.
- [x] Record evidence in ledger and commit task1.

## Task2: React navigation, visit recording and browser acceptance

**Files:** Create `apps/web/src/document-visit.ts`, `apps/web/test/document-visit.test.ts`, `apps/web/test/browser/personal-recent.py`; modify App.tsx, i18n.ts, styles.css and test-only pdf-browser-server.ts if needed.

**Interfaces:** `DocumentVisit` owns one explicit record per mounted document page, pending/saved/error state, lifetime abort and retry; uses existing fenced api. Recent uses existing file-list visual language, `/recent` navigation, dates, empty state and bounded load-more. It refreshes on activation and live invalidation; distinct retained library/Recent routes do not poll document pages or reorder visits. Blocked sessions clear private lists.

- [ ] Write controller/browser tests first: no duplicate visit for repeated view refresh; error/explicit retry; disposal/account fencing ignores late result; list opening alone does not record. Observe RED.
- [ ] Implement controller; integrate recording after first accepted document-page view. Add personal Recent navigation/list endpoint, ru/en/es labels and readable localized timestamps. Offer nonblocking retry status when visit fails. Clear items on request errors/invalidations before retaining newly unauthorized data; key lists by account identity.
- [ ] Run full web tests/typecheck/build. Run real-HTTP Chromium: empty initial Recent, two opened docs/reopen reorder, no reorder after background view refresh, other account empty, live revoke hides item, failed visit preserves preview and explicit retry works; mobile/keyboard navigation and no script errors. This fixture does not prove Safari/iOS or latency targets.
- [ ] Run diff gates, ledger evidence/remaining scope and commit task2. Continue overall approved plan; do not mark full goal complete.
