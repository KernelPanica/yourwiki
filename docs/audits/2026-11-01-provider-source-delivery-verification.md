# Existing Local source delivery — verification

Scope: accepted source updates to an existing verified Local binary object, background delivery/reconciliation, source-only page status and explicit actions. This does not complete external discovery/pull/create/rename/trash, cloud/native Google adapters/OAuth/grants, provider connection GUI or installation migration. Production remains Django. Real CODE/editor presence, target hardware and whole-page500ms acceptance remain open.

## Local protocol and page

- Source/version/preview/delivery request and indexed current job pointer commit atomically. Confirmed provider revision advances only with verified initial binding or stored delivery/read-back receipt.
- One delivery slot, immutable per-document target/baseline/config/author, current ACL/config and queue/document leases. No transaction spans provider IO. Paths/credentials never enter normal job/event/status DTOs.
- Local adapter pins root/parents, refuses traversal/symlinks/FIFO/nonregular files, streams64KiB and SHA-verifies <=4GiB, uses owned0600 candidate/fsync/atomic rename/parent fsync/read-back. Retiring a candidate fences a cooperating expired writer. This is optimistic against unrelated filesystem applications, not universal external-process CAS.
- Unknown/reclaimed writing can only retire/read back: target bytes confirm; unchanged baseline requires explicit retry; changed original conflicts; read errors stay unknown. Exhausted write retries schedule bounded operation-bound read-back; exhausted read-back cannot starve another document.
- GET source status reads local DB only and changes no state/jobs. Initial document view includes the same validated metadata, avoiding an extra initial sequential status request.
- POST retry requires current session/CSRF/read/write, matching retryable operation and latest local revision. It retires that operation and queues a new UUID attempt for already accepted bytes. It does not save editor contents. A repeated accepted intent is idempotent.
- POST check requires current write and an unknown/expired operation, latest local revision and request UUID. Queued/running read-backs coalesce; its payload pins the old immutable attempt, even if a newer local source exists. It cannot authorize replacement or clear conflict.
- Expired writing gates further source autosaves immediately, even before worker reclaim, through existing CONFLICT/recovery handling. A prepared attempt whose scope is revoked during backoff becomes durably blocked.
- React source panel has native buttons and ru/en/es labels, subscribes to current document invalidation, fences session/account changes, validates metadata and never saves/exits/reloads the editor. Lost action ACK reads status; no automatic POST replay. Source status never claims PDF annotation-layer delivery.

## Automated and browser results

Final native server:605/605,0failed/0skipped; frontend147/147; both TypeScript checks and production build pass. Logs: `/tmp/yourwiki-delivery-status-final-server.log`, `/tmp/yourwiki-delivery-status-final-web.log`, `/tmp/yourwiki-delivery-status-build.log`.

SQL1–29 compared byte-for-byte to46b4573 and unchanged. Append30 adds/backfills the latest delivery-job FK; version27/28/29 fixtures preserve all previous connection/binding/source/request/job values/checksums and clean FKs, with only the new pointer added.

Actual native HTTP confirms source metadata200, GET body400, CSRF/current-write/revision-fenced explicit retry, no source/provider revision change before delivery. Tests also cover atomic intent/event rollback, export/read separation, stale checks, role/session denial, private-field omission, expired-owner save gating and metadata without key/blob IO.

Actual Chromium393px, owned Local files/HTTP/queue:

- pending→confirmed changes exact original bytes;
- explicit retry, dropped successful POST ACK and reload produce one POST;
- unknown read-back produces no second replace;
- a changed PDF original retains the same dirty input DOM/value, and cancelling actual navigation retains the page with zero POST/PUT saves and no horizontal overflow;
- no page errors. PDF dirty buffer test freezes autosave time and explicitly refreshes status; it does not substitute a frozen-clock observation for live-invalidation timing.

Regression browsers pass account switch/no cross-account private requests, history restore/lost ACK/staged recovery, synthetic Office workspace/late readiness and Office restore/failed release/dirty-frame retention, all without exit saves. These Office fixtures do not run or certify real Collabora. Logs: `/tmp/yourwiki-delivery-status-final-browsers.log` (source pass; initial session harness lacked its standalone server), `/tmp/yourwiki-delivery-status-final-browsers-retry.log` (required owned server and remaining passes). Additional explicit dirty-navigation/POST+PUT capture rerun passes: `/tmp/yourwiki-delivery-status-source-exit-browser.log`. Screenshot: `output/playwright/provider-delivery-mobile.png`, visually inspected. The first source browser attempt exposed a fixture consuming an older superseded queue item rather than the PDF item; fixture now drains superseded items before asserting its target conflict.

## Actual4GiB process-death proof

Command:

```sh
node --max-old-space-size=48 apps/server/test/support/provider-large-transfer.ts /home/kernelpanica/Projects/yourwiki/output/native-provider
```

Owned native disk, generated4294967296 bytes, SHA256 `e3c54bcf405b91b23aef6983bda3d89613ecada8922496aee95a5ef35ddbdf9f`. A separate48MiB-heap worker replaced the original, then was SIGKILLed before local receipt. The owner was verified dead before expiring its synthetic leases. A new48MiB-heap process reconciled read-only into one durable receipt/provider revision2. The replacement count was1 then0; target inode stayed the same across reconciliation; first32 and final257 bytes were exact, with full source/target SHA verification in the worker. Owned8GiB source/target fixture was removed; parent output directory is empty.

| Process | Peak RSS KiB | Heap used at checkpoint bytes |
|---|---:|---:|
| Parent generation/validation |103520|10983704|
| Delivery worker before SIGKILL |159880|8339248|
| Reconciliation worker |165192|10716256|

Elapsed149126ms. Log `/tmp/yourwiki-provider-native4g.log`. This is streaming source delivery, not4GiB Office/PDF editing, browser upload throughput, whole-page performance or a2CPU/4GiB-host acceptance result. A later save-gate fix and initial-view metadata change do not alter this streaming/rename/reconciliation path; their separate final native/browser regressions pass.

## Performance scope

Current production entry JS245066 bytes /70066Brotli; CSS13772/3008; Inter font352240 bytes. These are entry resources, not total dependency/PDF/page bytes. Font/versioned asset caching remains existing immutable same-origin serving. No new frontend dependency or animation is added.

Owned loopback HTTP100 sequential samples per endpoint, bound pending source and actual auth/DB/manifest reads:

| Endpoint | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|
| Source status |0.769|1.056|1.279|1.999|
| Document view including source status |1.156|1.722|3.950|4.714|

Log `/tmp/yourwiki-delivery-status-api-latency.log`. This is API-only on the development host; it is not an Internet/cold-browser/phone/whole-page500ms result. Whole approved rewrite remains active.
