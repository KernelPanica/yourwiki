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

Grant migration checkpoint (2026-11-02): schema37 and `google-grants.ts` retain immutable trusted legacy receipts; `CredentialVault.googleRecipients` supplies current canonical scope to the metadata gate. Recognition preserves global Google object identity across mounts and all legacy statuses. Nine grants/11vault/six populated upgrade31–36 cases pass. See `docs/audits/2026-11-02-google-grants-verification.md`. Whole-backup migration runner, live grant delivery and source byte adapter remain pending.

- [ ] Pin file ID/private central ownership/managed-sharing/root ancestry/type/version; bounded metadata and timeouts, static errors; no credential forwarding on redirects. Legacy managed sharing remains supported.
Content protocol checkpoint (2026-11-02): `google-content-http.ts` streams fixed-origin binary/native export GETs in<=64KiB pieces, with size/budget/deadline/authority/cancellation guards, pre-body401-only GET retry and no body replay.19content cases/seven native ownedHTTP modes; actual4GiB loopback transfer with48MiB old-space flag and measured135176KiB RSS. Export limit is explicit through cached metadata/action receipts/ru-en-es UI, including page reload after refused explicit check. See `docs/audits/2026-11-02-google-content-verification.md`. Source metadata-before/after composition and quota-owned native unknown-length spool/adapter activation remain pending; no real Google acceptance.

Binary composition checkpoint (2026-11-03): `GoogleBinaryReader` privately composes metadata→exact stream→metadata, with single-use bodies and current authority/shutdown guards. Seven reader/four native owned HTTP worker cases prove managed sharing, encrypted central OAuth reuse, safe inbox commit/old-preview retention/no outbound echo, and changed-after-body refusal. Actual4GiB pre/post metadata stream proof uses143372KiB RSS. ProviderIngress now preserves typed source-conflict errors through cached status and ru/en/es warnings. See `docs/audits/2026-11-03-google-binary-verification.md`. Native spool, canonical root/reference/document-format factory, provider checksum validators and real Google activation/acceptance still pending.

Source-integrity checkpoint (2026-11-03): provider SHA256/MD5 and head revision are validated; binary acceptance requires a checksum and verifies it while streaming. Compact v2 fingerprint upgrades same bytes without another version. Canonical vault descriptor + `createGoogleBinarySource` pin DB root/reference/format and current scope, rejecting mismatched known-format MIME before media. Six native owned HTTP worker cases and actual4GiB checksum proof pass; native828/web160/types/build pass. See `docs/audits/2026-11-03-google-source-integrity-verification.md`. No public/CLI activation; unknown-size native export, unchanged-source hint and real-account acceptance still pending.

- [ ] Binary alt=media streamed<=4GiB with size/hash/after-read version checks. Native Docs/Sheets/Slides export to explicit supported formats with provider export limit and version-fenced snapshot; never infer native type from filename.
- [ ] Existing worker stages/commits authenticated sources without echo; offline/error retains old preview; native file is refused at binary-write boundary until supported native operation path is ready. Test real protocol via owned HTTP; preserve Local regression.

Native ingress checkpoint (2026-11-03): shared verified source reader handles explicit DOCX/ODS/PPTX exports, metadata-only unchanged hints and before/after version fences. Schema38 adds quota-owned bounded sizing to the existing inbox while preserving exact observations and migration receipts. Actual owned HTTP→inbox→real LibreOffice tests cover all three formats; actual partial-export SIGKILL/restart proves cleanup before a fresh receive. Native846/web160/types/build and refactored4GiB reader regression pass. See `docs/audits/2026-11-03-google-native-ingress-verification.md`. Public/CLI activation, real native export determinism/corpus/account acceptance and all write/lifecycle work remain open; Task3 is not marked fully complete.

## Task4: Binary conditional delivery and unknown-result reconciliation

- [ ] Verify current source identity/metadata/full bytes and conditional update semantics against official API; stream resumable upload with durable operation/session capability and size/hash checks, fail closed where no verified conditional primitive exists. No body buffering or implicit SDK write retry.
- [ ] Preserve source ID, read back accepted hash/version, handle412/stale parent/config/session/401/quota; unknown ACK reconciles read-only after process death, never blind retransmit. Native MIME always rejected by this path.
- [ ] Native HTTP worker/restart/full-source tests, explicit actions/browser and controlled large transfer; full gates/ledger/commit. Real provider acceptance remains a separate gate.

Status-protocol checkpoint (2026-11-03, base6270b26): `GoogleUploadStatus` implements an empty PUT probe with canonical fixed-origin session validation before auth, strict308 offsets, bounded200/201 identity, explicit404 expiry and quota/access distinction. Fifteen focused cases include five actual owned HTTP modes and shutdown/admission/late-response guards. No session creation, byte upload or public resolver activation yet. See `docs/audits/2026-11-03-google-upload-status-verification.md`. Pending: durable encrypted attempt-bound session receipts, verified conditional final commit and session quiescence before readback, whole worker/restart/large-source integration and real-provider acceptance. Do not infer v3 guarantees from unrelated Google APIs or old GData.

Journal checkpoint (2026-11-03, basebe9cfe7): schema39 retains one immutable-context encrypted session per delivery attempt, forward-only initiation/dispatch/unknown phases and no replay path. GoogleUploadJournal checks current lease/source/ACL/configuration before secrets; CredentialVault exposes a pinned outgoing-only capability, with metadata-only uncertainty recording allowed after revocation. Eleven journal cases include two actual SIGKILL boundaries and eight populated upgrades31–38. Historical SQL1–38 compared byte-for-byte with the base commit. See `docs/audits/2026-11-03-google-upload-journal-verification.md`. This does not activate upload IO; conditional final commit, HTTP initiation/streaming, worker composition/status quiescence/readback and real-provider acceptance remain required.

## Task5: Native documents and editing sessions

- [ ] Map existing Google-native corpus and supported lossless operations for Docs/Sheets/Slides; port structural Sheets batch semantics/merged cells/formulas/results and all conflict/session/error UI. Keep native ID and source version.
- [ ] Implement version-fenced export and supported structured saves or validated import-to-same-object only where preservation is proven; unsupported structures explicitly refuse. Preserve Yourwiki and external edit-session notices, local buffers and current permissions. Native collaboration cursors come from the selected collaborative editor, never fabricated.
- [ ] Corpus round trips/new preview after save/original identity/concurrent changes/partial or lost ACK and real-provider acceptance; full native/browser/types/build/ledger.

## Task6: Central OAuth UI, grants, discovery and lifecycle

- [ ] Current giga/CSRF OAuth state+PKCE/one-shot callback, fixed redirect/public-origin validation and encrypted credentials; existing identity/grant migration, no profile OAuth requirement for internal-only readers. No secret/log leakage or provider IO on ordinary page open.
- [ ] Durable per-identity Google grant/revoke from current inherited local ACL; original URL reflects actual object/type and current read/write rights. Provider owner rights remain an explicit external limit; no false export-block promise.
- [ ] Bounded authenticated changes/discovery/create/rename/move/trash/restore receipts retain Google IDs/parents/local ACL; external trash never inferred from transient404/permission/network errors. Yourwiki delete→Google trash and Google restore→Yourwiki recovery proven on real Google.
- [ ] Native/browser restart/migration/read-only/access denied/offline/error-popup regression; live Google acceptance with explicitly available central credentials, no private-user secret requests until genuinely required. Full roadmap continues into remaining providers/modules/installer/migration/target-hardware/SLO.

Consent-state checkpoint (2026-11-03, base1b795e0): schema40 plus GoogleConnectStates implement current Gigaadmin session/CSRF-bound one-shot state, encrypted S256 verifier, fixed configured callback,10min/session TTL, bounded retained work and semantic client/root identity fencing. Seven state cases plus nine populated upgrades31–39 pass; historical SQL1–39 compared byte-for-byte. See `docs/audits/2026-11-03-google-connect-state-verification.md`. No route/code exchange/token publication or public Google activation yet. Ruling: advance this independent Task6 prerequisite to prepare eventual supported real-account testing while Task4 conditional-commit evidence remains unresolved; no unconditional writer substitutes for the required safe save. Existing Strict cookies require a same-origin callback completion step.

Account verification checkpoint (2026-11-03, baseb7c8821): GoogleReadHttp.about obtains fixed permissionId/me; GoogleMetadata.root reuses the owned private/managed root gate. verifyGoogleAccount pins canonical encrypted configuration and prior account identity, validates new consent's owned root and requires a bound ownership witness for legacy root aliases without a marker. Eight account cases include two actual HTTP code→about→root chains; no configuration publication yet. See `docs/audits/2026-11-03-google-account-verification.md`. Next atomic publication/receipt and administrative callback/UI. User explicitly corrected priority to Google→parity→release→performance; performance edits remain deferred.

Atomic connect checkpoint (2026-11-03, base8d0a3c9): GoogleConnect now composes state→one-shot code exchange→account/root proof→atomic encrypted configuration/change event/result receipt. Schema41 adds bounded session-bound completion results; new DB/service replay is read-only, including an actual HTTP+SIGKILL after commit. Exact minted proofs/leases prevent copy substitution; rollback, racing config, refresh metadata preservation, pre-cancel, shutdown and TTL cleanup covered. Native914/focused36/types pass; SQL1–40 unchanged. See `docs/audits/2026-11-03-google-connect-publication-verification.md`. Next administrative routes/Strict-cookie callback/UI; no source writer/public provider activation yet.

Callback/routes checkpoint (2026-11-03, basedddd457): optional matching DB/origin GoogleConnect app wiring registers Gigaadmin/Origin/CSRF/bounded exact-JSON start/complete/result API. Fixed no-store/no-referrer/CSP callback removes code from URL, keeps only temporary state, completes once and recovers a lost response/reload through read-only result. Actual cross-site-link Chromium393×852 proves initial Strict cookie absent, successful completion, dropped ACK/reload no code replay, no secret storage/page errors. Five HTTP cases, full native919/web162/types pass; final hidden-style fix verified by fresh HTTP5 and full callback browser rerun. See `docs/audits/2026-11-03-google-connect-callback-verification.md`. Next Gigaadmin settings connection UI and configured-workspace wiring; Google source writer/lifecycle and real-account acceptance still open.

## Reference checks (2026-11-02)

Official Google [web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server) documents refresh-token POST and remaining expires_in, optional response fields and secure token persistence. [Drive downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads) distinguishes blob alt=media from native export and requires checking download capability. Provider limitations must be checked again at the task that implements them; this plan does not assert unsupported native conditional-write guarantees.

Settings checkpoint (2026-11-03, based8fa4f1): optional configured service advertises Gigaadmin-only account feature and bounded metadata list without provider IO/secrets. Lazy settings panel starts existing connection consent explicitly with current revision/CSRF, strict URL validation, session fencing and existing navigation guard. Lost start response requires read-only refresh before explicit retry. HTTP7/client5/full native921/web167/types/build and actual mobile Chromium settings→consent→Strict callback/lostACK/reload pass. See docs/audits/2026-11-03-google-settings-verification.md. Fresh connection setup/workspace bootstrap and safe writes/native/grants/discovery/lifecycle/live acceptance remain open; Task6 not marked complete.
