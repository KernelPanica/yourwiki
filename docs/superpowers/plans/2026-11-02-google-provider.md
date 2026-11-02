# Google Provider Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline with RED→GREEN and one fresh whole-rewrite review at the actual end. Execution is already authorized by the user; continue without per-task approval.

**Status:** Tasks1–2 COMPLETE (2026-11-02); Task3 IN PROGRESS (bounded GET transport verified); Tasks4–6 pending. OAuth verification: `docs/audits/2026-11-02-google-oauth-verification.md`. No Google file/network-account acceptance yet.

**Goal:** Restore Google Drive, native Docs/Sheets/Slides, central-account authorization, original-object access, permission delivery and external lifecycle synchronization in the TS runtime without losing legacy conflict/session behavior.

**Architecture:** Worker-only encrypted credential leases and bounded OAuth transport serve an identity-preserving Google adapter. Binary files use streamed reads and provider conditional writes with durable unknown-result reconciliation; native objects use explicit export and supported structured edits, never blind binary replacement. Discovery, grants and lifecycle have separate bounded durable jobs; pages use already prepared local versions/current local ACL.

**Tech Stack:** TS/Fastify/SQLite/BlobStore/current source workers and React. Fixed Google HTTPS endpoints, native fetch with injectable transport for owned loopback tests; no generic user-selected token endpoint and no automatic file-write retries. Preserve existing Fernet configuration/unknown legacy keys.

**Spec:** `docs/superpowers/specs/2026-10-30-yourwiki-rewrite-design.md` sections provider revisions/ACL/native Google; full roadmap stage5; inventory and legacy `wiki/storage.py`, Google OAuth/session/sharing/trash tests.

## Global constraints

- Full rewrite remains active; production/Django/CSP/editingReady unchanged. SQL1–35 immutable; migrations append only when required. Existing bound-source Local acceptance remains valid.
- Local Yourwiki ACL is authoritative and cached; deliver changes to Google asynchronously. No Google ACL import grants local rights, fake admin, silent public sharing or impersonation.
- Central refresh credentials never enter metadata/view/SSE/log/error DTOs. Routine refresh rotation preserves connection revision and pending job identity; explicit admin credential/root changes still fence stale capabilities.
- Source<=4294967296 bytes and64KiB stream operations; provider-native export limits are explicit provider failures, not proof of4GiB native support. Cached last-ready preview survives offline/failed export.
- No source write on HTTP GET/page open; existing source-slot, CAS/lease/session/current rights and unknown-result read-back rules remain mandatory. A native object is never overwritten by binary content or silently recreated with another ID.
- Preserve original-changed/conflict/session popups and user buffers. Unsupported native round trips refuse writes with a clear explanation rather than deleting structure. Real Google acceptance cannot be replaced by a fake-provider test or SDK claim.

## Review focus

1. Delayed token refresh after admin disable/reconfigure must not restore stale credentials; Task1 CAS/reopen tests.
2. Short token lifetime/slow exchange/concurrent callers must not extend validity or multiply refreshes; Task2 clock/parallel/cancellation tests.
3. Native object or moved/shared/trashed source cannot enter binary replacement; Tasks3–5 metadata/type/ancestry and original-ID tests.
4. Lost write ACK and changed original must retain local bytes, warn and reconcile without a second blind update; Task4 actual worker+fakeHTTP/restart tests, real-provider acceptance later.
5. Export/structured-edit limits and API quota failures retain last ready preview/buffer and actionable state; Tasks3/5/6 corpus and browser tests.

## Task1: Encrypted worker credential lease

Files: create `apps/server/src/providers/oauth-config.ts`, test `apps/server/test/provider-oauth-config.test.ts`.
Interface: `OAuthConfigs(db,configs).lease(connectionId,revision)` returns worker-only `{credentials(),check(),rotate(refreshToken)}`. `credentials()` returns copied `{clientId,clientSecret,refreshToken}` only after current enabled Google/revision/credential identity check. `rotate` atomically preserves unknown config fields, writes only encrypted_config, and keeps semantic revision/change events untouched. Blank/invalid tokens, corrupt ciphertext, wrong provider, changed client/secret/revision and disabled connection return static ProviderError.

- [x] RED missing module; tests actual encrypted SQLite config + reopen, copied credentials, rotation persistence/no revision/no event, unknown fields, concurrent stale rotation, admin change/disable and corrupt/wrong provider refusal with no secret in error.
- [x] Implement short synchronous transactions and credential comparison with no provider IO/transaction across IO. No public route or new schema.
- [x] Focused tests/types then full native/web gates and ledger/commit.

## Task2: Bounded Google token exchange

Durable foundation (2026-11-02): append36 + `oauth-refresh.ts`/companion atomic config rotation verified by10 refresh tests,5 credentials tests,5 populated upgrades, full native712/web158/types/build. Unknown same-token requests stay blocked across cosmetic revisions. Bounded token exchange now has19 focused tests including3 native loopback HTTP cases; worker-owned bounded cache/canonical minted capabilities and awaitable shutdown now verified; full native743/web158/types/build pass.

Files: create `google-tokens.ts`, bounded token-response helper if needed, `provider-google-tokens.test.ts`.
Interface: one worker auth session per current lease, `access(options:ProviderCheck):Promise<string>`, `invalidate(accessToken)`, `close()`. POST fixed `https://oauth2.googleapis.com/token`, form refresh grant, manual redirect refusal,64KiB maximum JSON, finite timeout+abort, valid nonempty bearer token/finite expires_in. Cache lifetime begins before exchange with safety margin; exhausted/short-lived tokens never get extended. Singleflight concurrent refresh plus a durable per-connection refresh lease across worker processes (append migration if needed); CAS alone must not discard a concurrently issued rotating refresh token. A cancelled waiter must not poison other callers. Persist new refresh token via Task1 before exposing access token. Stale401 invalidation must not clear newer token. Errors static, no provider body/URL/secrets. Ignore unrecognized JSON fields; no refresh/write retry loop.

- [x] RED slow/short lifetime, singleflight, waiter cancellation, rotation CAS failure, invalid JSON/type/oversize/redirect/deadline/401 and secret redaction using controlled transport and native loopback HTTP.
- [x] Implement and integrate current worker credential capability/resolver lifetime without enabling incomplete Google file writes.
- [x] Full native/web/types/build, ledger/commit.

## Task3: Verified Google metadata and streamed source reads

Files: Google transport/metadata/read adapter modules and worker resolver, focused fakeHTTP and native worker tests.

Transport checkpoint (2026-11-02, base4107beb): `google-read-http.ts` provides fixed-origin file/permission GET, one bounded401 GET retry, fresh source authority,256KiB JSON/30s/eight-active-read limits and cancellation/static errors. `google-json.ts` now shares fixed-buffer control JSON decoding with token exchange.21 transport +10 vault composition cases pass, including native OAuth→Drive GET chain and4native metadataHTTP modes; final native765/web158/types/build pass. This is no ownership/root/sharing acceptance yet. Complete those guards (including trusted managed grant receipts from legacy state) before enabling any source adapter; native export/bytes remain pending.
Metadata preflight checkpoint (2026-11-02): `google-metadata.ts` + nine tests (including owned HTTP) verify typed IDs/central ownership/root ancestry/native MIME/version/binary size and named managed sharing through a required trusted lookup. See `docs/audits/2026-11-02-google-metadata-verification.md`. Durable grant receipts/import and real source adapter wiring remain pending; this gate alone does not authorize content acceptance.

- [ ] Pin file ID/private central ownership/managed-sharing/root ancestry/type/version; bounded metadata and timeouts, static errors; no credential forwarding on redirects. Legacy managed sharing remains supported.
- [ ] Binary alt=media streamed<=4GiB with size/hash/after-read version checks. Native Docs/Sheets/Slides export to explicit supported formats with provider export limit and version-fenced snapshot; never infer native type from filename.
- [ ] Existing worker stages/commits authenticated sources without echo; offline/error retains old preview; native file is refused at binary-write boundary until supported native operation path is ready. Test real protocol via owned HTTP; preserve Local regression.

## Task4: Binary conditional delivery and unknown-result reconciliation

- [ ] Verify current source identity/metadata/full bytes and conditional update semantics against official API; stream resumable upload with durable operation/session capability and size/hash checks, fail closed where no verified conditional primitive exists. No body buffering or implicit SDK write retry.
- [ ] Preserve source ID, read back accepted hash/version, handle412/stale parent/config/session/401/quota; unknown ACK reconciles read-only after process death, never blind retransmit. Native MIME always rejected by this path.
- [ ] Native HTTP worker/restart/full-source tests, explicit actions/browser and controlled large transfer; full gates/ledger/commit. Real provider acceptance remains a separate gate.

## Task5: Native documents and editing sessions

- [ ] Map existing Google-native corpus and supported lossless operations for Docs/Sheets/Slides; port structural Sheets batch semantics/merged cells/formulas/results and all conflict/session/error UI. Keep native ID and source version.
- [ ] Implement version-fenced export and supported structured saves or validated import-to-same-object only where preservation is proven; unsupported structures explicitly refuse. Preserve Yourwiki and external edit-session notices, local buffers and current permissions. Native collaboration cursors come from the selected collaborative editor, never fabricated.
- [ ] Corpus round trips/new preview after save/original identity/concurrent changes/partial or lost ACK and real-provider acceptance; full native/browser/types/build/ledger.

## Task6: Central OAuth UI, grants, discovery and lifecycle

- [ ] Current giga/CSRF OAuth state+PKCE/one-shot callback, fixed redirect/public-origin validation and encrypted credentials; existing identity/grant migration, no profile OAuth requirement for internal-only readers. No secret/log leakage or provider IO on ordinary page open.
- [ ] Durable per-identity Google grant/revoke from current inherited local ACL; original URL reflects actual object/type and current read/write rights. Provider owner rights remain an explicit external limit; no false export-block promise.
- [ ] Bounded authenticated changes/discovery/create/rename/move/trash/restore receipts retain Google IDs/parents/local ACL; external trash never inferred from transient404/permission/network errors. Yourwiki delete→Google trash and Google restore→Yourwiki recovery proven on real Google.
- [ ] Native/browser restart/migration/read-only/access denied/offline/error-popup regression; live Google acceptance with explicitly available central credentials, no private-user secret requests until genuinely required. Full roadmap continues into remaining providers/modules/installer/migration/target-hardware/SLO.

## Reference checks (2026-11-02)

Official Google [web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server) documents refresh-token POST and remaining expires_in, optional response fields and secure token persistence. [Drive downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads) distinguishes blob alt=media from native export and requires checking download capability. Provider limitations must be checked again at the task that implements them; this plan does not assert unsupported native conditional-write guarantees.
