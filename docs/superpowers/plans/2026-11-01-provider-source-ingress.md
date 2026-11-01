# Provider Source Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, RED→GREEN per task, one fresh whole-rewrite review at the actual end.

**Goal:** Mirror externally changed existing verified Local binary originals into Yourwiki with prepared previews, truthful external provenance and conflict-safe publication, without echoing imported bytes back to the provider.

**Architecture:** An immutable provider-origin fact permits a technical source version with no Yourwiki human author. A durable inbox pins a read snapshot and local/binding/config baseline. A separately scheduled inbound worker stages bounded authenticated bytes and commits only while the source is clean and unfenced; publication reuses the existing preview pipeline and retains the previous readable preview until ready. External mismatches with local pending work remain explicit conflicts with retained snapshots.

**Tech Stack:** Existing TS/SQLite/Fastify/React/BlobStore/jobs/LocalAdapter; no new dependency or production activation.

**Spec:** ../specs/2026-10-30-yourwiki-rewrite-design.md revisions/save/preview/notifications; main roadmap stage5; existing docs/write-contract.md and migration/notification contracts.

## Global Constraints

- Full rewrite remains active. Existing bound binary/source objects only here; discovery/new objects, rename/move/trash/restore, cloud/native Google/OAuth/grants and installation-wide migration follow. Native Google objects must never accidentally use binary replacement.
- SQL1–30 immutable. Append31 for nullable technical author plus deferred, immutable provider-origin facts; later schema additions separate. No fake user, fabricated active admin, impersonated owner or permission import from Google. Local Yourwiki ACL remains authoritative.
- Source bytes <=4294967296, bounded64KiB IO, no file Buffer/base64/JSON duplication, no SQLite transaction across IO. Use initialized explicit new workspace/provider roots and owned synthetic fixtures only.
- Current enabled connection/config generation, live document/folder chain, immutable binding and job/slot lease are checked before/between IO and before commit. Trusted background capability derives from the already verified binding and configured connection, not a browser cookie or an inactive/privileged fake actor.
- Pending local source changes, unresolved outbound attempts, durable incoming saves/uploads, active/pending Office work and retained recovery fence automatic replacement. A concurrent local save after snapshot start invalidates the inbox baseline. Client-only unsaved PDF edits retain their DOM/buffer and encounter existing revision conflicts; never save on exit.
- Outbound provider_revision advances only for actually verified provider bytes. Inbound local/provider source revisions advance together after accepted snapshot commit; no provider.deliver request is created. PDF annotation layers are separate and never claimed delivered.
- Same-content metadata changes update only verified baseline, not source/history/preview counters. Network/access/missing-object errors are not deletion authority.
- Reuse global history flag/limits and exact existing export/import semantics. A Local external human author is unknown: nullable captured_by and empty name round-trip as existing unknown author, never falsely as a Yourwiki user. The separate immutable origin records the verified provider connection/fingerprint.
- Production/Django/CSP/editingReady unchanged. Real CODE, target2CPU/4GiB/15users/Redmi/Safari and500ms whole-page acceptance remain unproven. No API timing substituted for full-page latency.

## Review Focus

1. Parent source-table rebuild must preserve all preview/PDF/provider FK rows and checksums; interruption must roll back before restart. Task1 upgrade/corruption/SIGKILL tests.
2. Nullable authors must not become a public bypass to write anonymous local versions; provider origins require valid deferred version/binding references and cannot be appended to an existing human revision. Task1 SQL guards/trusted helper tests.
3. Local save, Office handoff or retained incoming data arriving during external IO must prevent commit while preserving both local and incoming bytes. Tasks2/3 race/lease/reopen tests and Task4 dirty-browser tests.
4. Inbound acceptance must never enqueue outbound replacement or claim PDF-layer sync, even with history disabled and unchanged-content timestamps. Tasks3/4 queue/baseline/counter assertions.
5. Cheap unchanged probing is a read-only scheduling hint, never authorization for replacement or an unverified byte commit; changed paths/links/FIFO remain safe. Task4 probe/adapter tests plus existing outbound full-integrity regression.

## Files

- schema.ts append31 and foreign-key rebuild registry; providers/version-origins.ts validates trusted provenance staging.
- history-capture.ts shared budget/capture mechanics with separate user-authorized and trusted external entry points, keeping existing human path unchanged.
- providers/ingress-inbox.ts, ingress-guards.ts: immutable staged snapshots, quotas, local/Office/save/upload fences and explicit conflict state.
- providers/ingress-commit.ts: origin-aware source acceptance, preview-only enqueue and provider baseline acknowledgement, no outward write.
- providers/ingress-worker.ts, ingress-scheduler.ts and credential-vault.ts: explicit binding capability, shared provider-source slot, bounded polling/snapshots/leases.
- providers/local-adapter.ts/local-paths.ts and adapter.ts: optional unchanged-version probe; no cached proof in replace.
- separate provider-sync status/routes/client/component/i18n: external-source notification without changing the existing7-field outbound DTO or bypassing dirty editor guards.
- focused native tests, migration-crash child, HTTP/browser fixtures and large-transfer support. Default production startup remains unchanged.

## Task1: Truthful external provenance and compatible technical versions

**Interfaces:** `stageProviderOrigin(db,{documentId,revision,connectionId,fingerprint,observedAt})` is internal/trusted and requires a transaction. It stages no source bytes and grants no HTTP authority. Deferred FKs bind `(documentId,revision)` to the technical version and `(documentId,connectionId)` to its immutable provider binding at commit. `captureProviderSourceHistory(db,documentId,nextDigest,now)` is trusted commit-only; unknown Local human capture uses null author/empty name, same flag/quota/digest semantics as normal capture. No method accepts an arbitrary public actor.

- [x] Write tests that fail for missing origins module/schema: user versions unchanged; null-author versions require matching origin and live configured connection; origin precedes provider revision, cannot be added to a human version; dangling deferred origin fails transaction commit, mismatched binding/connection fails; immutable origin and referenced original identities; no HTTP route/source job created by staging alone.
- [x] Run `node --test apps/server/test/provider-version-origins.test.ts apps/server/test/provider-version-migration.test.ts`; Expected missing module/schema RED.
- [x] Append31: rebuild document_versions with the same6 columns/values/PK/FKs except nullable author; preserve/recreate the dependent provider_attempt_source trigger; register atomic FK-disabled rebuild with before-commit foreign_key_check. Add a unique binding(doc,connection) parent index, deferred immutable origin table and insert/update author/origin consistency guards. New-document origin may precede future version/binding within a trusted transaction; all references must exist at commit. No provider origin may be retrofitted to an existing user version.
- [x] Add trusted origin helper and external history capture with no fake author/account. Verify user capture still requires current active user; external capture requires existing transaction/live bound connection and live ancestry; the ingress commit owns clean/concurrent-write guards (ledgered separation), and capture leaves data unchanged on limits; global history off captures nothing. Historical content/download/export remain current-document scoped.
- [x] Test source30 populated preview/PDF/binding/request/active attempt migration, reopen/checksums/FKs, preexisting corruption refusal and SIGKILL after uncommitted source drop. Compare SQL1–30 exact to23e311e. Run full native server/web/types; Expected all pass with0skips; ledger and commit. Task1 does not yet enable inbound acceptance or polling.

## Task2: Guarded durable external snapshot inbox

**Interfaces:** `ProviderIngress.stage({job,documentId,connectionRevision,baseLocalRevision,baseProviderRevision,baseFingerprint,observedFingerprint,blob,observedAt},now)` accepts only already stored/verified bytes under a current binding capability; immutable UUID receipt/state and per-doc generation. `guards(db,documentId,baseline)` rechecks resource ancestry, config/binding/revisions, outbound and Office/save/upload/recovery fences. Snapshots are private and confer no digest-only access.

- [ ] RED tests for immutable snapshot/byte identity, current guards, no partial visibility, bounded pending budget, worker lease expiry, two DB owners, restart and same snapshot dedupe; no deletion on read errors.
- [ ] Append inbox/usage schema with <=4GiB per source,16GiB global pending bound and indexed per-document bounded active records; status error codes static and credential/reference-free. Separate staged/conflict/applied/discarded states; unknown remote deletion is not inferred.
- [ ] Implement guards using existing save/Office semantics, extracting shared fence helpers only where needed with old behavior regressions. External changes during local pending work park an authenticated snapshot and emit document-only conflict hints; never discard current source.
- [ ] Verify focused/full native/types, quota and crash evidence, exact old SQL; ledger/commit. Expected no production scan, no provider mutation and no source overwrite yet.

## Task3: Atomic external source commit and preview publication

**Interfaces:** `ProviderIngress.commit(snapshotId,claim,now)` is internal background publication with no user impersonation. Only verified current snapshot/binding/config/lease plus a clean unchanged local baseline may create a null-author origin-bound source version. Same bytes update only baseline; changed bytes capture optional history, increment local revision, acknowledge provider revision/fingerprint, enqueue preview and persist inbox receipt/event atomically. No source-delivery job or PDF-layer claim.

- [ ] RED exact-byte commit/no-echo/history-off tests; local source/Office opening/room/ingress/upload/journal/recovery/ACL or connection changes during async verification; failed receipt/preview/history limit must roll back all pointers and retain snapshot.
- [ ] Implement shared source staging primitives or trusted commit function without loosening normal DocumentService write/session/ACL rules. Published preview stays at the previous ready revision until existing preview worker atomically publishes the newly prepared manifest.
- [ ] Prove durable replay after dropped acknowledgement/reopen and kill points, staged future receipts cannot publish, client-side dirty PDF remains for explicit recovery, unchanged content does not grow history/source/jobs, unknown provider author stays null and history export/import round-trips existing unknown-author representation.
- [ ] Run focused and full native server/web/types/build and relevant preview/history/Office regressions. Expected no source mutation on refused guard and no outbound echo; ledger/commit.

## Task4: Background inbound scheduler, truthful status and current editor

**Interfaces:** optional adapter `changed(reference,baseline,ProviderCheck):Promise<boolean>` is a read-only hint; absence falls back to bounded read. Local compares pinned stat identity against the versioned private baseline before choosing a full scan; malformed baseline always reads. `IngressWorker.runOnce(signal?)` shares leased provider-source slot with outbound, resolves only trusted binding/config, streams to BlobStore and stages/commits or parks. Poll known enabled/live bindings in50-item keyset batches with persisted cursor/due time; default fallback30s, no mount-wide crawling or HTTP/page provider IO. Cloud notification/delta implementations follow in provider-specific plans.

- [ ] RED Local unchanged-probe zero-content-read tests, symlink/FIFO/path replacement, same-size/mtime restored mutation via ctime/inode; no probe shortcut in outbound replace. Queue/scheduler bound/fairness/restart, transient access/missing errors retain old published source and no trash event.
- [ ] Implement explicit/injected binding credentials without fake active admin, worker CLI integration and abortable lifecycle. Every accepted actual snapshot still verifies full bytes/identity; probe cannot authorize write. Expose separate provider-sync GET metadata and explicit check/apply/discard actions where needed under current ACL/CSRF; do not break the existing outbound DTO. Ready cached preview remains usable while offline/staging.
- [ ] Add ru/en/es incoming notification/native controls and preserve all existing conflict/unknown/session/Office popups. Active unsaved editing blocks or conflicts with application; no auto-save/exit/reload/forced overwrite. A provider-origin known byte version may be confirmed present in storage without falsely claiming it was uploaded by Yourwiki.
- [ ] Real Local file→background staging→new preview→readers and dirty-editor HTTP/Chromium cases, pending local revision retained, incoming clean application/no outward replace, restart and controlled4GiB inbound stream with bounded heaps. Measure bundle/API scope, not whole-page SLO. Run full native server/web/types/build/browser gates, ledger/commit and continue cloud/native Google/discovery/trash/grants and full roadmap.

Self-review: nullable-author rebuild is necessary to preserve attribution honestly; a fake owner/admin would grant the wrong provenance and permission model. Deferred immutable facts keep current6-column user versions and existing child references compatible. Incoming acceptance is distinct from outward delivery and has a separate status contract, so no incoming event can authorize a blind external write. New sources still use the same prepared-preview publication boundary.
