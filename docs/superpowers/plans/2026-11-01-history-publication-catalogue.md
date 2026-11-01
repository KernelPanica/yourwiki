# History publication catalogue implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task inline. No implementer/reviewer per task; the approved whole rewrite retains its final branch review.

**Goal:** Remove the entry-count-dependent HTTP-thread transaction from history import publication while retaining atomic visibility, stable public IDs, exact legacy archives and all current editor/session safeguards.

**Architecture:** Store canonical imported records and their original metadata privately during intake/preparation. Reserve a contiguous range of public receipt IDs and flip one import publication record atomically after validation/adoption. Distinguish immutable physical SQLite keys (existing foreign-key targets) from public history receipt IDs; public metadata/content/preview/restore contracts stay numeric and compatible. This extends the approved short-publication-transaction architecture, rather than introducing another service.

**Tech Stack:** Existing TypeScript/Fastify, better-sqlite3 WAL, durable blob namespaces, React clients unchanged except if a regression requires a correction. No Redis, new dependency, long open async SQLite transaction, deferred authorization or integrity-proof cache.

**Spec:** ../specs/2026-10-30-yourwiki-rewrite-design.md; parent plan ./2026-10-31-global-history.md; evidence ../../audits/2026-10-30-rewrite-progress.md.

## Global constraints

- Preserve migration SQL1–24 exactly. Task1 appends25; once committed,25 is also immutable and any later SQL correction appends26+. If another approved feature lands first, use the next free version without rewriting committed migrations.
- Source/PDF technical revisions remain independent of optional global history; default history remains off,40GiB raw history refs/file and100000 entries/file.
- Preserve legacy revision0, empty format, duplicate/reused revisions, full original metadata, deleted-author labels, published IDs, native/PDF data and already-issued preview/restore receipts.
- Continue treating the user's explicit500ms bound for usable cached pages as the acceptance target. The design's1s/0.5s wording is not proof that the stricter target has been met. Neither4GiB transfer completion nor all invisible data belongs in a500ms page-readiness claim.
- Existing local/provider status distinction, all warnings/popups, no save-on-conflict/exit, dirty editor retention, permissions/export/CSRF and account fencing remain mandatory.
- Keep the current8GiB import reservation/15 actor pending/100000 receipt-record limits, one leased heavy import, and4GiB per original. No uncharged adopted blob deletion or automatic mutation replay.
- The whole rewrite/cutover, actual target hardware, real CODE/presence/provider/Safari/mobile parity and old Git updater acceptance remain separate gates.

## Evidence and decision

A native4GiB original/5.73GB archive has passed HTTP intake, private staging, durable publish, tail range, native text validation/restore and streamed export with a48MiB parent heap. However, a controlled100000-record publication still blocks one event-loop turn for1710ms even after statement reuse reduced compilation to37 statements. The previous per-row version exceeded48MiB heap; the500-record regression compiled6534 statements. Merely moving this transaction to another SQLite connection/process would leave writer contention and synchronous busy-timeout stalls in the HTTP process. Yielding an async transaction on the shared connection would expose uncommitted rows to unrelated requests. Neither is an acceptable fix.

Ruling: public history identity must be independent of provisional physical row identity — otherwise either IDs/order change at publication or publication must mutate/copy100000 records — cost: all FK-backed preview/restore consumers must explicitly resolve public IDs, with legacy-cache migration tests before activation.

## Review focus

1. A private imported row whose physical ID equals an unrelated public ID must never be discoverable through metadata, content, preview, restore or export; Tasks1–3 test this.
2. Local saves interleaved with private intake must retain descending public pagination and export high-water snapshots, including deleted historic high IDs; Tasks1–2 test this.
3. Existing schema24 prepared/committed imports, active previews and staged restores must survive migration/restart without ID/metadata changes or duplicate references; Tasks1,3–4 test this.
4. Expired/revoked actor/session/lease, malformed final envelope, failed adoption or SIGKILL must reveal zero partial imports and retain recovery/reservations; Task4 tests each phase.
5. Metadata up to64KiB/record must not be copied en masse at confirmation or cleanup. Cleanup must not remove committed canonical history or release quota before actual private bytes are removed; Tasks4–5 test this.

## Task1: Add private/public identity and publication invariants

**Files:** modify apps/server/src/schema.ts; create apps/server/src/history-catalogue.ts; extend apps/server/test/database.test.ts; create apps/server/test/history-catalogue.test.ts.

**Interfaces:** `HistoryCatalogue(db)` owns `lookup(documentId,publicId)`, `byStorageId(documentId,storageId)`, `page(documentId,{after?,limit})` and `publicId(documentId,storageId)`. A catalogue reference includes `{documentId,publicId,storageId}`; it is an internal type and must not be serialized as a public DTO. Existing physical IDs stay the foreign-key targets. Local receipt insertion allocates a public ID through a single sequence; new imported rows keep null public IDs and an immutable import/ordinal binding until their root publication supplies the public range.

- [x] Write RED migration/catalogue tests: schema24 checksum/data/sequence preservation, a deleted high public ID never reused, existing public IDs copied exactly, private rows hidden, local IDs allocated while1000 private rows exist, root public range reserved once, and immutable identity/metadata bindings.
- [x] Run `node --test apps/server/test/database.test.ts apps/server/test/history-catalogue.test.ts`; observe the missing-schema/API failures.
- [x] Append schema migration: public sequence initialized from the old AUTOINCREMENT high water, nullable public IDs plus import/ordinal binding on canonical history rows, indexed local public ordering, indexed committed import ranges, canonical prepared counters/readiness. Existing committed imports keep their original public IDs and receipt JSON unchanged. Existing prepared/pending rows remain resumable and are not fabricated as published. Adapt usage triggers so private intake neither exposes nor charges committed history; one final publication applies the accepted aggregate exactly once. Store original metadata once in history_legacy_metadata, whose canonical FK row now exists during private intake. Retain old staging JSON only where needed for schema24 recovery/conversion.
- [x] Implement catalogue lookup and bounded key-page selection. Use default50/max200 pages for backend compatibility: select at most limit+1 local keys/ranges and limit+1 candidate keys/range (51 by default,201 maximum), merge bounded keys before fetching only the returned metadata records; never materialize/sort all100000 metadata payloads. Numeric public IDs remain monotonic in publication order; roots with0 entries reserve no IDs.
- [x] Verify both files, TypeScript, diff gates; commit the compatible foundation while old importer activation is unchanged.

## Task2: Resolve all public history reads through the catalogue

**Files:** modify apps/server/src/history-read.ts, history-capture.ts, history-export.ts; extend history-read/history-routes/history-legacy-read/history-transfer tests.

**Interfaces:** `HistoryRead.reference(userId,documentId,publicId)` returns an authorized internal reference in the current read snapshot; `entry/list` still return the existing public DTO, with no storage ID/private import fields. `HistoryRead.legacyMetadata(userId,documentId,publicId)` is the internal exact-export metadata accessor and requires export rights. `authorizeExport`, `exportSnapshot` and bounded `exportIds` provide current authority and public high-water enumeration without parsing unrelated history. Export snapshots use the public sequence/ranges at open, not physical SQLite keys.

- [x] Write RED tests: reserved physical IDs guessed through every read route return404; interleave local captures and publication of two imports, then verify50-row descending pages and stable public cursors; an export opened before publication excludes that entire import even if its physical rows already exist. Include private orphan rows, zero-entry imports and old deleted high IDs.
- [x] Run focused read/routes/legacy/transfer suites and observe failures before replacing raw history_entries scans.
- [x] Route read/list/export through catalogue keys; preserve whole-blob integrity, per-chunk scope checks, exact legacy metadata and existing no-store/export restrictions. Local capture uses the public sequence in its existing source/PDF transaction. Do not alter source/PDF save, WOPI or warning behavior.
- [x] Verify focused suites/TypeScript/diff gates and commit before activating private intake.

## Task3: Keep preview/restore FK references private and public contracts stable

**Files:** modify apps/server/src/history-previews.ts, history-preview-manifest.ts, history-restore.ts and routes only where resolution is required; extend preview/restore routes/native/crash tests and history-restore-client-http.test.ts.

**Interfaces:** preview generations/jobs and restore FK rows use storageId internally. Prepared manifests, HTTP paths, operation status and receipt JSON retain publicId. Persist a public binding where a durable receipt needs it; schema24 values backfill exactly. No private reference enters a client snapshot or asset URL.

- [x] Write RED tests with intentionally different public/storage IDs: prepare/view/assets/retry, native reuse, saved/staged/discarded restore, source/layer conflict, private-ID guessing, cross-document/account denial and SIGKILL/restart. Include already-issued schema24 ready preview manifests and staged restore operations.
- [x] Run targeted preview/restore suites to observe reference failures.
- [x] Resolve references explicitly at service boundaries, retain public IDs in immutable prepared manifests/receipt JSON, and keep their validation/account/session/lease checks. Existing prepared namespaces and engine-version pinning remain usable; no automatic source save/replay is introduced.
- [x] Verify focused native suites plus real client HTTP test/TypeScript/diff gates and commit.

## Task4: Build canonical private records before short publication

**Files:** modify apps/server/src/history-import.ts; add focused catalogue staging/cleanup helpers in history-catalogue.ts; extend history-import/transfer/crash tests and support children.

**Interfaces:** catalogue `stageImportEntry({importId,generation,ordinal,metadata,blob})` runs inside a bounded caller transaction and returns storageId. `publishImport({importId,generation,token,now})` runs inside the caller's short IMMEDIATE transaction and returns `{entries,totalBytes,firstEntryId,lastEntryId}` from accepted prepared counters. `deleteFailedPage({importId,generation,token,maxRows:50,maxMetadataBytes:1048576})` removes only owned hidden records and reports `{removed,done}`. Authorization/lease/blob IO remain in HistoryImport.

- [x] Write RED tests: native intake stages hidden canonical rows; final bad envelope/digest exposes none; exact publication with an interleaved local save uses a fresh public range and charges usage once; lost ACK/replay/SIGKILL preserve a complete-or-empty result. Migrate/resume schema24 prepared entries in bounded pages before publication, preserving their metadata and original intent. Test partial conversion restart and legacy committed receipt replay.
- [x] Run import/transfer/crash tests to observe old bulk-publication behavior.
- [x] Activate private canonical intake with immutable import/ordinal identity and per-root counters. All metadata parsing/validation and source verification/adoption happen before the final transaction, in bounded asynchronous work. Convert old prepared staging JSON to canonical rows and null the duplicate only after its exact canonical copy exists. Final commit only rechecks current authority/lease/budget/readiness, reserves a public range, updates aggregate usage, writes the root receipt/flag and event. It must not loop, parse metadata or copy archive records.
- [x] Make failed/legacy-duplicate metadata cleanup yield between pages bounded by50 rows and1MiB; keep generation/lease fencing and reservation until metadata plus physical namespace cleanup succeed. Committed canonical history is permanent, never staging garbage. Adoption-started prepared failures stay retained/charged.
- [x] Verify full relevant/native suites, TypeScript, diff gates and commit the activated path.

## Task5: Prove bounded critical work, compatibility and current UI behavior

**Files:** update apps/server/test/support/history-import-publish-latency.ts, history-large-transfer-child.ts, history-large-transfer.test.ts; extend browser history-import/history-panel/history-restore scenarios; ledger this plan and parent plans.

- [ ] Write a deterministic RED structural assertion that no per-entry SQL mutation/metadata parsing occurs between final authority check and root receipt commit; it must remain constant between500 and100000 entries. Do not make timing-only CI claims. Use an external HTTP observer during100000-entry preparation/publication to record page/metadata latency, not only an in-process timer.
- [ ] Run the failing probe, implement only remaining bounded-path corrections, and rerun it. Host measurements above500ms remain failures/remaining work, not renamed success.
- [ ] Run `node --max-old-space-size=48 apps/server/test/support/history-large-transfer-child.ts 4294967296 <owned disk parent> --progress` and inspect complete native HTTP/import/restore/export evidence; never place the4GiB file in tmpfs for disk acceptance. Verify namespace cleanup and exact legacy author/date/revision0 bytes. Do not claim a4GiB HTML preview or physical-phone acceptance from this test.
- [ ] Run native server suite, web suite, both typechecks/build and real Chromium import/read/restore/settings/Recent regressions, including old ready cache manifests and a dirty current editor. Record actual counts, bundle changes and timing scope; commit after diff gates.
- [ ] Leave the full rewrite goal active and continue the approved roadmap. Only mark this subproject complete when public IDs, private visibility, all compatibility tests and the bounded critical-work acceptance are proven; keep the broader500ms/real-device/provider/CODE gates explicit.
