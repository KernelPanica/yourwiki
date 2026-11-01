# Provider Source Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, RED→GREEN per task, one final whole-rewrite review.

**Goal:** Deliver accepted source-file saves to an existing bound provider object asynchronously, with real local-file delivery, explicit uncertain outcomes and no blind replay or false cloud-success notice.

**Architecture:** An immutable document→connection/reference binding and coalescing durable request join the existing local source commit. A per-document attempt pins bytes/author/baseline/config generation before any provider mutation. A separately leased worker streams the original through an adapter; uncertain writes require read-only reconciliation and explicit retry. The first concrete adapter is Local, on Linux with pinned directory descriptors and fenced temporary files. Cloud/native Google adapters reuse this protocol in subsequent plans rather than being treated as byte-equivalent local files.

**Tech Stack:** Existing Node/TypeScript/Fastify/React/SQLite/BlobStore/JobQueue. No new dependency, provider account or production switch.

**Spec:** ../specs/2026-10-30-yourwiki-rewrite-design.md save protocol/current ACL/providers; main roadmap stage5; legacy docs/write-contract.md, wiki/storage.py Local/Adapter and save/recovery notification contract.

## Global Constraints

- Whole rewrite stays active. This subproject covers updating an existing bound binary/source object. External discovery/pull, create/rename/move/trash, Google native conversion/grants/OAuth, PDF-layer immutable remote objects and complete provider UI/migration are explicit next work, not completed by source delivery.
- Never edit committed SQL1–26. Append27. Source/PDF/history technical revisions and immutable blobs remain authoritative local accepted data; history off does not disable conflict/recovery.
- A local save acknowledges Yourwiki durability only. Provider success requires a stored acknowledgement/reconciliation receipt. Unknown/conflict blocks automatic write replay; no save on editor exit.
- All originals up to4GiB stream in bounded chunks; no document Buffer/base64/JSON payload, credential/reference in queue events/normal metadata DTO or long SQLite transaction across IO.
- Current active author/read/write ACL, live/nontrashed document, enabled connection/config revision and operation lease are rechecked before/between IO and immediately before mutation. A browser session may end after accepted commit; the worker uses accepted author plus current server ACL, never a fabricated session.
- Source-only status must say “исходный файл”; it must not imply PDF annotation layers or all external modules were delivered. Preserve all existing editor/Google conflict/error/popups and dirty buffers.
- Atomic same-directory replacement protects local-file completeness; Local is optimistic relative to unrelated external applications, not a universal filesystem CAS. Never claim otherwise. Yourwiki worker attempts must be fenced; reclaimed/uncertain attempts first retire their own private candidate and only reconcile read-only.
- Test only owned synthetic directories/keys/HTTP fixtures. No real mount/account/cloud write. Production/Django, CSP and editingReady stay unchanged.
-500ms whole-page,2 CPU/8GiB/15 users/phone/Safari/CODE/provider live/large Office-PDF acceptance remain open; no timing-only CI claim.

## Review Focus

1. A crash or lost receipt after actual provider replacement must not cause another write; Tasks2/3 SIGKILL and dropped-ACK tests require reconciliation/one durable receipt.
2. A superseded or expired worker paused just before rename must not publish after a replacement owner; Task2 gates that boundary and proves retiring the operation-owned candidate prevents late rename. This fences cooperating Yourwiki attempts, not arbitrary external clients.
3. Local paths/symlink/FIFO substitution must not escape the explicit provider root or retain descriptors/memory; Task2 tests traversal, intermediate/final links, nonregular files and cancellation.
4. Concurrent local saves arriving during delivery must remain pending after an earlier acknowledgement; Task1 coalescing and Task3 worker tests pin both immutable attempt and newest request.
5. ACL/config/account changes or remote-original conflict during streaming must stop new mutations and retain local bytes/dirty editor; Tasks1/3/4 test scope and status without auto retry/reload.

## Files

- providers/source-bindings.ts, delivery-requests.ts: local binding, accepted source request and current-write guard.
- providers/adapter.ts, local-adapter.ts, local-paths.ts: bounded provider IO, safe errors and Local descriptor/candidate handling.
- providers/delivery-attempts.ts, delivery-worker.ts, credential-vault.ts: durable attempt/lease/state transitions and separate internal credentials.
- providers/delivery-routes.ts: current-document status and explicit safe retry.
- web provider-delivery client/component plus i18n/App integration: source-only status, no editor replacement or exit save.
- append schema.ts; hook documents.ts central source commit; explicit worker command under providers/worker-main.ts, leaving preview worker separate.
- focused tests for each module plus native HTTP/browser/large-transfer/crash support.

## Task1: Bind accepted sources and atomically request delivery

**Interfaces:** internal `bindExistingSource(db,{documentId,connectionId,reference,fingerprint,confirmedRevision,confirmedDigest,confirmedSize,now})` requires local immutable version agreement and an enabled connection; caller has already verified the remote original (no public arbitrary-reference action). Binding kind is exactly `binary-source`, immutable connection/reference/generation1. `requestSourceDelivery(db,documentId,revision,now)` runs only inside the source commit and is a no-op if unbound. `assertSourceDeliveryWritable(db,documentId)` rejects an unresolved conflict/unknown/retry-required gate with existing CONFLICT, preserving current editor recovery handling. Local-only files remain unchanged.

- [x] Write RED tests: only known local version/digest can bind; no provider revision fabricated; same verified bind idempotent, different object rejected; accepted upload/journal/Office/history restore central commits atomically advance requested_revision and enqueue `provider.deliver` with `{documentId,requestedRevision}` only; rollback captures no phantom request/job; multiple saves coalesce to latest without changing an active pinned attempt; unbound/PDF-layer-only save unchanged; conflict/unknown gates retain incoming recovery rather than overwrite; binding/queue payload never leaks reference/credentials.
- [x] Run focused tests and observe missing module/schema failures.
- [x] Append27 binding/request schema, then28 for tested immutable attempts (ledgered split). Binding references documents/connection and confirmed immutable document version, holds private reference<=4096/fingerprint<=1024 and confirmed_revision. Request stores latest accepted revision. Attempts store immutable UUID/doc/revision/author/blob/base fingerprint/binding generation/config revision and state prepared/writing/unknown/confirmed/retryable/conflict/blocked, bounded safe error/receipt and lease. At most one unresolved attempt/doc. State transitions/identity guarded; requests monotonic and version FKs enforced. No source bytes in SQL.
- [x] Hook the existing central source commit only: local source version, preview job and delivery request/job in one transaction. Current getPublished.providerRevision represents last actually confirmed delivery; trusted initial binding records only its verified baseline. Do not enqueue PDF-layer delivery or provider create by guessing a path. Retain bounded per-document pending state and existing recovery/Office checks.
- [x] Run focused source/journal/Office/history/native suites, SQL preservation, TypeScript and diff gates; commit.

## Task2: Bounded Local adapter and physical stale-candidate fence

**Interfaces:** `ProviderAdapter.read(reference,{signal,check}) => Promise<{fingerprint:string;size:number;bytes:AsyncIterable<Uint8Array>}>`; `replace({operationId,reference,baseline,target:BlobRef,source:AsyncIterable<Uint8Array>,signal,check}) => Promise<{fingerprint:string;digest:string;size:number}>`; `retire({operationId,reference,signal}) => Promise<void>` removes only the owned private candidate before reclaim reconciliation. `ProviderError(code,{outcome:'not_written'|'unknown'})` contains static safe code only. `LocalAdapter.open(root:string)` explicitly opens the selected existing root; `close()` closes all owned descriptors after active operations settle.

- [ ] Write RED real filesystem tests: stream exact bytes/ranges of supported read API (full stream only here), source/baseline hash mismatch prevents original replacement,4GiB admission, empty and multi-megabyte files, safe fingerprint detects inode/mtime/content change, fsync/rename failure distinction, no mutation on abort/revoked check, slow-source cancellation and descriptor cleanup.
- [ ] Add traversal/absolute/empty/dot segments, intermediate/final symlink and FIFO tests. Linux implementation pins root/each parent dir with O_DIRECTORY|O_NOFOLLOW|O_NONBLOCK and operates through /proc/self/fd; final files use O_NOFOLLOW/nonblocking and regular-file checks. Never resolve user references with a plain unchecked join. Only explicit trusted root may be resolved initially; root replacement cannot retarget open handles.
- [ ] Add RED late-writer gate: pause an old operation immediately before rename, retire its UUID candidate, then release it and prove no target mutation. Candidate `.yourwiki-delivery-<UUID>` is reserved and cannot be a bound original name. Failures before mutation are known not_written; rename/ack/fsync ambiguity is unknown. No deletion/rollback of original on unknown.
- [ ] Implement bounded64KiB IO, size<=4GiB and SHA verification while staging, candidate0600/fsync, final current-scope/baseline checks, atomic same-parent rename and directory fsync, read-back receipt. Fingerprint is versioned opaque tuple of dev/ino/mtimeNs/ctimeNs/size/SHA strings, never JS-rounded integers. Retire/unlink+fsync fences old candidate paths; never recreate the same operation's candidate after retirement/reclaim.
- [ ] Verify focused native tests, memory/crash support, TypeScript/diff gates and commit. Do not claim external-application CAS or network-filesystem guarantees from local fixture tests.

## Task3: Durable asynchronous delivery worker and reconciliation

**Interfaces:** `DeliveryWorker(db,store,vault,resolveAdapter,{clock?}).runOnce(signal?)` claims only provider.deliver/reconcile kinds, uses one delivery slot plus per-doc attempt lease30s/renew10s and current guards between IO. `CredentialVault` privately decrypts current enabled connection for worker only; no giga impersonation, browser token or public config getter. Adapter resolution is explicit/injected; binary Local supported here, other/native kinds fail safely without writing.

- [ ] Write RED tests for real Local save→delivery→providerRevision, requests2/3 before/during IO, wrong baseline/conflict, read/write/author/account/config disable/revision change, corrupt source/missing bytes, lease expiry and two worker connections, no preview-job consumption, bounded shutdown, safe errors and preserved local versions.
- [ ] Persist prepared immutable attempt before IO and writing state before any adapter replace. Confirm source fingerprint/binding/current scope and verify original BlobStore integrity; no cached proof. A confirmed acknowledgement atomically advances binding fingerprint/providerRevision only to the pinned target and finishes its job; newer requests stay pending. Emit document-ID-only local invalidation events. No provider credentials/private reference in job/event/status.
- [ ] Test SIGKILL before attempt, during candidate write, after rename/before receipt and after confirmation; lost ACK and all reclaimed writing attempts retire their candidate then reconcile read-only. Target bytes match => confirm once; baseline matches => retryable requiring explicit user retry; different remote state => conflict. Read failure stays unknown. Never automatically call replace from reconciliation or clear a conflicting external original. Known not_written failures may use bounded retry/backoff only when not a scope/conflict/invalid-source failure.
- [ ] Implement explicit worker CLI with initialized new DB/store/key paths and Local resolver; no default old workspace discovery or production activation. Worker loops wait abortably, memory bounded separately from HTTP/preview; close codecs/descriptors on shutdown.
- [ ] Verify focused/native source/journal/Office/history suites and TypeScript/diff gates; commit.

## Task4: Source delivery status and explicit retry in the current editor

**Interfaces:** GET `/api/documents/:id/provider-delivery` current read ACL returns `{documentId,kind:'source',state:'local_only'|'pending'|'sending'|'confirmed'|'unknown'|'retryable'|'conflict'|'blocked',localRevision,providerRevision,operationId:null|string,errorCode:null|string}`; no reference/fingerprint/config/digest authority. POST `/api/documents/:id/provider-delivery/retry` with same-origin CSRF/current write, `{operationId,baseLocalRevision}` accepts only matching retryable operation/latest revision. Unknown only offers read-back check; conflict cannot be cleared by retry. Existing ordinary source save warnings remain authoritative.

- [ ] Write RED API/client tests: read/write/export isolation, session/account fencing, strict input, stale local revision, unknown GET recovery/no replay, explicit retry only, newer save during check, current permission change and safe errors. Status is DB-only and does not contact provider during page opening.
- [ ] Add small source-only status UI using native buttons and existing live document invalidation. “Сохранено в Yourwiki” stays local; “Исходный файл передан в хранилище” requires confirmed receipt; unknown/conflict preserve mounted dirty editor, stop automatic retry, expose existing permitted copy/download/recovery actions and never save on exit. Do not imply PDF annotation-layer/provider-native support or show credential/config internals. Preserve ru/en/es.
- [ ] Real HTTP+Chromium test with owned Local root: edit accepted source, status pending→confirmed, exact original file bytes; dropped ACK/reload only checks; original changed conflict with dirty editor retained/no exit write; revoked access and account switch;393px. Add native4GiB existing-source streaming delivery under bounded parent/worker heaps, exact target and crash receipt; do not claim4GiB Office/CODE editing or500ms page SLA.
- [ ] Run full native server/web suites, both typechecks/build and relevant browser regressions, measure current bundle/latency scope, ledger/diff gates and commit. Continue external pull/create/rename/trash, cloud/native Google adapters/grants and the full approved roadmap; no cutover/completion claim.

Self-review: source update is end-to-end for an existing verified Local object; unsupported mutation kinds remain explicit separate protocols and cannot accidentally pass through binary replacement. Remote IO never spans a SQLite transaction. Retained immutable local bytes and source-only notices prevent a partial provider rollout from pretending full sync/parity.
