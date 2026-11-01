# Central Provider Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, tests first; the approved entire rewrite retains one final whole-branch review.

**Goal:** Persist central encrypted provider connections/mount identities with safe administrative metadata and resumable trusted migration, without exposing server tokens or silently rebinding existing originals.

**Architecture:** Append a connection/mount repository and immutable legacy-import receipts. Credentials use the existing Fernet key/SecretConfigs boundary; current giga-admin scope and optimistic configuration revision protect edits. A read-only administrative HTTP boundary exposes an allowlisted metadata DTO without decrypting configurations. Provider-specific OAuth/connect forms, document bindings, network adapters and delivery/reconciliation follow in their own plans; configuring this repository does not establish a live connection.

**Tech Stack:** Existing TypeScript/Fastify/SQLite/SecretConfigs, no new dependency or frontend bundle.

**Spec:** ../specs/2026-10-30-yourwiki-rewrite-design.md central providers/migration; ./2026-10-30-yourwiki-rewrite-roadmap.md stages1/5/12. Legacy wiki/mounts.py requires superuser and freezes path plus root/repository/branch/host/port/share/host_key on edits; blank secret fields retain previous credentials. Provider names: local/google/onedrive/github/smb/sftp.

## Global Constraints

- Whole rewrite remains active. No production/Django/cutover, real key/config/provider account, OAuth exchange, external probe/write/grant/trash or editor warning change.
- SQL1–25 are immutable. Append migration26 only; preserve all previous data/checksums/FKs and exact source/PDF/history IDs.
- Existing key is explicit/authoritative; encrypt configuration with SecretConfigs. Never return ciphertext, secret values, arbitrary unknown config fields or private filesystem/provider locations through the metadata DTO/events/errors.
- Keep all6 legacy providers and unknown config fields. Per record plaintext1MiB/token2MiB limits; no truncation/auto credential reset.
- Only active giga admins manage/read central connection metadata, matching current Mountpoints authorization. Simple admins/members cannot acquire it through direct API. Future workers use separate internal authority, not impersonated browser sessions.
- Configured means local configuration persisted, never remotely authenticated/connected. Reads/readiness/pages do not contact provider APIs. No provider job is enqueued before the delivery protocol exists.
- Public usable-page500ms target,4GiB originals,15 users/2 CPU/8GiB, CODE/Safari/phone/VPN/provider live tests remain separate. Trusted migration imports one record at a time; no unbounded HTTP installation scan.

## Review Focus

1. A credential update racing another admin or future worker must reject stale revision and retain the previously accepted config; Tasks1/2 test CAS/reopen/rollback.
2. Changing provider/root/remote identity on an existing mount must not retarget documents; Task1 rejects immutable fields even when old values exist only in encrypted JSON.
3. Repeating a legacy import after runtime credentials changed must return the original import receipt, never overwrite newer state; Task2 tests it and rejects changed source bytes with the same legacy identity.
4. Role/account revocation between request authentication and service mutation must fail locally; Tasks1/3 test current role, missing/inactive user and strict session/CSRF rules where applicable.
5. Errors/DTOs/events/unknown fields must not leak plaintext, ciphertext, external server paths, refresh tokens or keys; all tasks use sentinel assertions, including corrupt stored ciphertext and missing key service.

## Files

`apps/server/src/providers/connections.ts`: authorized repository/mount metadata/config CAS; `connection-types.ts`: provider/DTO/input types; reuse DocumentError codes INVALID_REQUEST,ACCESS_DENIED,NOT_FOUND,CONFLICT and add CONNECTION_EXISTS,CONNECTION_IDENTITY_IMMUTABLE,CONFIG_UNAVAILABLE,MIGRATION_MISMATCH (static messages only); `connection-import.ts`: trusted one-record legacy receipt boundary; `connection-routes.ts`: read-only administrative HTTP routes. Append schema.ts; register reads in app.ts only when an explicit configured repository is supplied. Tests: provider-connections.test.ts, provider-connection-import.test.ts, provider-connection-routes.test.ts; extend database.test.ts upgrade coverage.

## Task1: Encrypted connection/mount identity repository

**Interfaces:** `ProviderConnections(db,configs,{clock?})`; `create(userId,{id,provider,label,path,folderId:null|string,config})`; `list(userId,{after?:string,limit?:number})`; `get(userId,id)`; `update(userId,id,{baseRevision,label?:string,enabled?:boolean,configPatch?:Record<string,unknown>})`. IDs are explicit opaque1..128 safe characters; labels1..200; paths absolute normalized virtual mount paths up to2048 characters/32 segments, `/` allowed for the one root; folderId references an existing non-trashed folder resource for a new non-root mount; the virtual root `/` has null folderId. Path segments follow the existing wiki.folders.validate_directory_name rules (1..200 characters, no . / .., reserved DOS basename, forbidden slash/backslash/NUL/<>:\"|?* or trailing dot/space), no empty/repeated/trailing segments. Default list50/max200 with keyset cursor. DTO exactly `{id,provider,label,path,folderId,revision,enabled,state:'configured',createdAt,updatedAt}`. No configuration accessor in this public service; future adapter service gets a separate internal credential boundary.

- [x] Write RED migration/repository tests: append26 preserves schema25 active histories/previews/restores/imports; create/reopen all6 providers and exact encrypted unknown config round-trip through test-only DB+SecretConfigs; only giga; duplicate path/id and nonfolder binding rejected; bounded pages; CAS/no-op/rollback; encrypted bytes absent from DTO/events/errors; missing/closed codec/corrupt stored config makes credential mutation fail with CONFIG_UNAVAILABLE and no change; label/enabled-only changes and metadata reads never decrypt and remain available.
- [x] Run `node --test apps/server/test/provider-connections.test.ts apps/server/test/database.test.ts`; observe missing module/schema failures.
- [x] Append26 tables: `provider_connections(id,provider,label,encrypted_config,revision,enabled,created_at,updated_at)`; `provider_mounts(connection_id PK FK RESTRICT,path UNIQUE,folder_id UNIQUE nullable FK resources RESTRICT)`; dedicated `provider_connection_changes(connection_id,revision,created_at)` audit (separate from document-scoped events), and next task's `provider_connection_imports(legacy_key PK,connection_id FK RESTRICT,source_fingerprint hex64,created_at)` immutable receipt table. Constraints enforce provider enum, bool/revision/bounded ASCII ciphertext; provider and mount identity immutable, folder binding validated as kind=folder; prevent changing the kind of a mounted folder resource. Root path iff folderId is null. Keep settings/history/auth data untouched.
- [x] Implement current-role authorization, strict types/admission and identity-field preservation. Freeze provider and encrypted root/repository/branch/host/port/share/host_key; merging a patch keeps unknown keys and blank existing secret fields (`client_secret,refresh_token,token,password,private_key,key_passphrase`). Configured is explicit; no network job/readiness claim. Only changed values bump revision; same-value CAS is a no-op, stale CAS always CONFLICT. All changes atomic, safe events contain id/revision only. Metadata reads select no encrypted_config column and never use the codec. Label/enabled-only edits also require no decryption, so a broken connection can still be disabled. Keep transactions bounded by one configuration.
- [x] Verify focused tests/TypeScript/diff gates and commit.

## Task2: Trusted one-record legacy migration receipts

**Interfaces:** `importLegacyConnection(db,configs,{legacyKey,id,provider,label,path,folderId,encryptedConfig,now}):{legacyKey,connectionId,state:'imported'}`. No user HTTP entry point. legacyKey is explicit stable1..256 ASCII migration identity; caller operates on a stopped-source backup. Authenticate/decrypt original source token with the supplied existing key, preserve original ciphertext exactly on first insert (no silent re-encryption/JSON rewrite), retain all unknown fields and remote identity. An immutable receipt binds SHA256 of canonical ordered `{id,provider,label,path,folderId,tokenSha256}` source metadata; digest is internal and never exposed. Repeat same source returns receipt even after runtime edits; changed source under same key fails MIGRATION_MISMATCH. No reading of live legacy DB or whole-installation importer is implied.

- [ ] Write RED tests: all6 synthetic legacy rows, exact ciphertext copied, Workspace root/Mountpoint identity supplied without inferred duplication, rollback on path/folder collision, wrong key/corrupt/oversize retains source and inserts nothing; replay/reopen after runtime credential update leaves it untouched; changed token/provider/path/id under same legacyKey rejected; source credentials absent from receipt/event/error.
- [ ] Run focused import tests, observe missing importer failures.
- [ ] Implement source validation before one short atomic insert+receipt transaction. Receipt schema in26 uses immutable metadata/digest and FK to retained connection. Do not invoke admin create via a fake user, regenerate keys, perform provider calls, scan all legacy rows or silently resolve colliding mounts.
- [ ] Run migration/repository/import tests/TypeScript, diff gates and commit.

## Task3: Safe read-only administrative HTTP metadata

**Interfaces:** optional `AppOptions.providerConnections?:ProviderConnections`; register only when supplied. GET `/api/admin/provider-connections?after=&limit=` returns bounded DTO page; GET `/api/admin/provider-connections/:id` returns DTO. Current cookie/session and giga role are mandatory; arbitrary query/body/coercion rejected. No route returns config/token/location or accepts writes until provider-specific validation/connect flows are implemented. Existing app without configured secrets retains previous startup/readiness behaviour.

- [ ] Write RED HTTP tests: supplied repository only,401 anonymous,403 simple/member/inactive/revoked; unknown id404; strict cursors/limits/query;50/next pages; no ciphertext/credential/unknown fields in JSON or errors; corrupt ciphertext/closed codec do not break safe metadata reads and are never returned; no provider IO or secret read for unrelated health/document pages.
- [ ] Run route tests, observe404/missing-option failures.
- [ ] Register private no-store GET routes with existing error/session conventions and current service authorization; map INVALID_REQUEST400,ACCESS_DENIED403,NOT_FOUND404,CONFLICT/CONNECTION_EXISTS/CONNECTION_IDENTITY_IMMUTABLE/MIGRATION_MISMATCH409,CONFIG_UNAVAILABLE503 without exception detail; add optional AppOptions wiring only. No frontend/config writer/automatic OAuth probe or production startup change.
- [ ] Run full native server/web tests, both typechecks, migration SQL preservation checks, diff gates and commit. Ledger results and continue real provider document-binding/delivery plans under the active whole rewrite goal.

Self-review: addresses the approved central-account persistence/migration prerequisite only. OAuth refresh serialization, per-provider connect validation, native Google round-trip, grants/export restrictions/trash, provider outbox/reconciliation and admin UI remain explicit subsequent deliverables, not claims made by this repository/metadata boundary.
