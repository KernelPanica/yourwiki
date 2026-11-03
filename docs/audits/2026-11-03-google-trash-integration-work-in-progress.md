# Google trash integration — historical WIP checkpoint, 2026-11-03

Superseded later in the same session by [the broad code verification](2026-11-03-google-stage-code-verification.md): native1090/web192/types/build and five browser scenarios passed. The approval-capacity limitation below describes the earlier failed attempts; it no longer blocks the current local verification. The full Google stage remains incomplete.

Base60d4895. Uncommitted checkpoint; the full native/HTTP/browser gates have NOT passed for this diff. Google and the entire ordered goal stay active/incomplete. Deferred performance files are untouched/excluded from this feature.

## Implemented current worktree

- Optional UUID `operationId` marker is snapshotted with the boolean flag into reserved Drive `appProperties.yourwikiTrashOperation`. Marked ACKs must return that marker; private receipts bind it to one execution. Lifecycle reads project only the validated marker, never arbitrary custom properties.
- Append45 `provider_google_trash`: immutable actor/request/document/binding/connection/source context; one unresolved per document and original reference; forward-only queued→dispatched/unknown/acknowledged→confirmed/failed phases;100kintent cap. Historical migrations1–44 compared byte-for-byte to `/tmp/yourwiki-google-trash-base-schema.ts` and remain identical.
- Simple/Giga admins may request trash; only Giga may explicitly request restore. Local trash and exact idempotent intent/job are atomic. All bytes/versions/provenance survive. Current role, local source, live parent chain, binding and connection guards; busy provider/save/Office work refuses. Local restore waits for verified current remote state. Cached ACL invalidation follows existing resource triggers.
- One shared-source-slot worker, shared bounded OAuth pool and fifth fair provider-loop queue. Mark-before-HTTP then one PATCH; dispatched/unknown recover by metadata GET/marker only, never another PATCH. Role loss after dispatch permits read-only resolution and system observation, never a new write. Missing marker after dispatch-before-network stays unknown and blocks opposite intents; explicit check may re-arm readback only.
- Confirmed trash watches recognize positive verified Google restoration and restore local visibility, scheduling a canonical `provider.pull`.404/network/current-scope failure never implies restoration or deletion. Watch jobs reuse one token-fenced metadata job per intent instead of appending a new job every minute. A failed later restore attempt does not stop the last valid trash watch.
- Metadata-only current-admin/CSRF API: POST `/api/documents/:id/google-trash`, GET `/api/admin/google/trash`, GET `/api/admin/google/trash/:id`, POST `/api/admin/google/trash/:id/check`. Configured v2 app and provider CLI are wired; no change to default health-only/Django Docker startup.
- Lifecycle evidence does not require content-download permission or4GiB content acceptance. Ownership/root/identity/type/sharing checks still apply. Ordinary source reads retain the download/size gates; a restored oversized original can expose the retained cached preview and let incoming sync report its content limit.

## Verified evidence in this turn

- Marker missing-method/response RED: `/tmp/yourwiki-google-trash-marker-red.log`; marker protocol31/31 initially passed with native execution `/tmp/yourwiki-google-trash-marker.log` before durable integration. That run precedes the latest lifecycle size-gate adjustment, so it is not a final protocol regression claim.
- Missing durable module RED `/tmp/yourwiki-google-trash-jobs-red.log`; initial fixture incorrectly left provider_revision0 (legitimately DOCUMENT_BUSY), corrected imported baseline; current admission/idempotency/current-role/restore/immutable-context/phase/migration tests pass.
- Route RED `/tmp/yourwiki-google-trash-routes-red.log`→actual Fastify injection admission/status/list/CSRF/hide/reopen GREEN. It is API injection with fake provider transport, not a socket or live-account test.
- Missing readback-check method RED `/tmp/yourwiki-google-trash-extra-red.log`→explicit readback-only rearm GREEN.
- Duplicate legacy alias admission RED `/tmp/yourwiki-google-trash-alias-red.log`→explicit SOURCE_AMBIGUOUS refusal. Shared-alias lifecycle is still a requirement/gap, not solved by refusal.
- Failed restore disabling the valid external-restore watch RED `/tmp/yourwiki-google-trash-watch-red.log` ('idle' rather than 'restored')→query ignores failed later intents; superseded watches refuse.
- Content-limit coupling RED `/tmp/yourwiki-google-trash-content-limit-red.log`→separate lifecycle-only parsing preserves content-read gates.
- Latest safe sandbox inline core23/23,zero fail/cancel/skip: `/tmp/yourwiki-google-trash-core-final-local.log`; includes jobs7,worker9,routes1,lifecycle metadata1,provider loop5. Tests prove logical fake-provider worker restart, exact marker/no second PATCH, periodic external restoration, role revocation, no404 inference, bounded watch jobs, dispatch-before-network ambiguity, immutable/populated44 migration, actor restrictions and fifth-queue fairness.
- Latest server types pass `/tmp/yourwiki-google-trash-core-types.log`; `git diff --check` passes.

## Verification limitation and next action

Automatic approval review failed repeatedly because its selected model was at capacity (one earlier request timed out). The affected escalated commands were NOT executed; this was a review-service failure, not an unsafe-action determination. A safe sandbox inline core suite succeeded. Attempts including existing real-listen tests in the sandbox fail with `listen EPERM 127.0.0.1`: configured-app24pass/1environmentfailure `/tmp/yourwiki-google-trash-core-local.log`, protocol28pass/3environmentfailures `/tmp/yourwiki-google-trash-protocol-local.log`. Do not report these as green suites or rewrite/skip the tests to hide sandbox failures. No corresponding process remains running. No source/worker logic failure was observed in those outputs.

Next: restore the permitted native runner/approval-service availability, run existing real HTTP plus full server/Office tests with this diff, fix any actual regression; add actual marked HTTP/restart boundary cases, current configured runtime/CLI verification and mobile API-worker browser acceptance. Then build admin trash UI/document controls using current navigation/editor guards, capability DTOs and retained error/session popups. UI is not implemented by this checkpoint. Record all final gates before committing this WIP; no Git write/push/merge/deploy attempted for it.

## Rulings and remaining scope

Ruling: private attempt marker plus one-shot dispatch, rather than a matching boolean alone, is used to reconcile a lost ACK — cost a reserved provider property and actual-Google metadata atomicity acceptance. No automatic PATCH retry when marker is absent; crash-before-network uncertainty is deliberately retained pending a reviewed recovery path.

Ruling: lifecycle read evidence is separate from source-download authority — cost an explicit parser mode and incoming content refresh after restoration; this does not grant bytes/export access.

Ruling: reuse one watch job per intent with fresh lease tokens, instead of accumulating minute-by-minute receipts — cost watch job state can re-arm after terminal metadata-only checks; original mutation jobs never re-arm as writes.

Ruling: reject shared legacy Google aliases for destructive admission pending a shared-source lifecycle model — cost a temporary explicit feature gap for duplicate original IDs; unrelated documents/bytes/edits remain intact. This is not final parity and must be resolved before whole-Google completion.

Safe binary/native saves, grants, create/move, all notices/editor integration, whole Google acceptance and the later parity/release/npm Docker/migration/backup/Git/target-hardware stages all remain open. No fresh full1052/500ms/iOS/Redmi claim for the current uncommitted diff.
