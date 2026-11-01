# Provider Secret Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task inline. Execution of the approved full rewrite is already authorized; retain its one final whole-branch review.

**Goal:** Read and write the existing encrypted configuration format without regenerating installation keys or requiring reconnection of central provider accounts.

**Architecture:** A bounded Fernet compatibility codec uses Node's existing cryptographic primitives, verified against the official format and Python cryptography. An explicit read-only key loader opens an operator-selected existing key; a per-record configuration verifier provides the next migration/provider subsystem with authenticated JSON while retaining unknown configuration fields. No application route reads these secrets, and no external API or production installation is touched by this subproject.

**Tech Stack:** Existing TypeScript/Node26 crypto/fs, no new dependency, synthetic Python cryptography interoperability fixture/verification only.

**Spec:** ../specs/2026-10-30-yourwiki-rewrite-design.md (central providers, migration), ./2026-10-30-yourwiki-rewrite-roadmap.md stages1/5/12; ../../audits/2026-10-30-migration-contract.md. Legacy sources: wiki/crypto.py, wiki/models.py, install.py.

## Global Constraints

- Continue the entire approved rewrite. This codec/preflight does not complete provider adapters, OAuth/grants/sync/trash or installation migration; current Django production remains active.
- Preserve committed SQL1–25 exactly; this subproject needs no database migration.
- The existing `encryption.key` is authoritative. Never generate, rotate, rewrite, chmod or move it implicitly. Missing/wrong/corrupt keys produce a bounded safe error and retain all source bytes.
- Fernet protects small configuration, never4GiB document bytes. Bound plaintext at1MiB and encoded token at2MiB; oversize existing records stop preflight without truncation. Limits are explicit implementation admission bounds, not new provider payload limits.
- Never put key, plaintext, token, provider credentials or filesystem paths into exceptions, normal DTOs or logs. Only operator-supplied safe record identity and error code may identify a failed preflight record.
- Keep existing JSON fields (including unknown/provider refresh fields) and Unicode values. Decrypt does not enforce token TTL: legacy crypto.decrypt has none. Fernet age does not replace OAuth token expiry handling.
- This module does not expose or change authentication cookies, live provider calls, CSP/editingReady, editor state, Google warnings/popups, file publication or frontend bundles.
-500ms usable-page acceptance, physical Redmi/iOS/Safari, real CODE/providers,2 CPU/8GiB/15 users and complete4GiB Office/PDF remain separate gates. Migration scans must not run as unbounded work on the HTTP thread.

## Review Focus

1. Wrong key, altered version/timestamp/IV/ciphertext/tag or malformed length must never return unauthenticated bytes; Task1 tamper tests cover each field and valid-MAC invalid padding.
2. A key file replaced by symlink, directory or oversized file must fail without reading another target or creating a new file; Task2 exercises NOFOLLOW/fstat/bounded read and unchanged-source checks.
3. Valid old configuration with old timestamps, escaped Unicode, refresh credentials or unknown nested fields must survive; Tasks1/3 cross-Python and JSON tests pin it.
4. User-controlled exceptions/invalid JSON must not echo credentials or key/path/token data; all tasks assert stable redacted error messages and codes.
5. Closing the codec must prevent later use; concurrent caller mutation of input buffers must not change owned key state; Task1 lifecycle tests cover copies/disposal. Buffer clearing is best effort, not a promise of eliminating every JS/crypto temporary copy.

## Files and responsibilities

- `apps/server/src/providers/secret-errors.ts`: small stable typed errors with no input-derived message/cause.
- `apps/server/src/providers/fernet.ts`: format codec and authenticated byte boundaries only.
- `apps/server/src/providers/secret-key.ts`: explicit existing-file loader, permissions/file-type/bounded IO, no generation.
- `apps/server/src/providers/secret-config.ts`: bounded authenticated JSON objects and one-record migration preflight.
- `apps/server/test/provider-fernet.test.ts`, `provider-secret-key.test.ts`, `provider-secret-config.test.ts`: native tests, synthetic fixtures only.
- `apps/server/test/fixtures/fernet/`: public official vectors and reproducibly generated dummy Python tokens; record source/license and generation commands. No real installation secret is read for testing.

## Task1: Authenticated Fernet compatibility

**Interfaces:** `new FernetCodec(key:string|Uint8Array,{maxPlaintextBytes?:number}={})`; `encrypt(plaintext:Uint8Array):string`; `decrypt(token:string):Buffer`; `close():void`. Default max plaintext1048576; allowed override1..1048576. Token cap2097152. Static `SecretError.code` values include INVALID_SECRET_KEY,INVALID_SECRET_TOKEN,SECRET_TOO_LARGE,SECRET_CLOSED. Returned byte buffers are caller-owned. Random IV and current Unix seconds come from Node runtime; tests use official deterministic decrypt vectors and Python interoperability, not a production deterministic-IV option.

- [x] Write tests: official known vector decrypt; old-timestamp synthetic Python JSON; Python decrypts a new TS token; empty/Unicode/binary plaintext; two encryptions differ; wrong key; one-bit changes in every token field; invalid alphabet/base64/short token/version/block lengths/tag/padding; plaintext/token size limits; input key-buffer mutation; closed codec; error strings contain none of the sentinel key/token/plaintext.
- [x] Run `node --test apps/server/test/provider-fernet.test.ts`; observe missing-module failures.
- [x] Implement the exact version0x80 format with Node AES-128-CBC PKCS7, HMAC-SHA256 over version/time/IV/ciphertext and constant-time comparison before decryption. Copy key material, validate URL-safe encoding/decoded lengths, bound allocation before decoding/decrypting, and normalize all cryptographic errors to the stable type. No TTL check for stored configuration.
- [x] Run focused tests/TypeScript and inspect native Python interoperability output; diff gates and commit.

## Task2: Read-only existing installation key loading

**Interfaces:** `loadSecretCodec(path:string):Promise<FernetCodec>`. Explicit path only. Open O_RDONLY|O_NOFOLLOW, require regular file and no group/world mode bits, read at most129 bytes to enforce128-byte file bound, support surrounding ASCII whitespace/newline around a valid32-byte URL-safe key, close fd on every path. Missing/unsafe file => SECRET_KEY_UNAVAILABLE; malformed existing content => INVALID_SECRET_KEY. No input-derived error detail.

- [ ] Write tests using private temp files: valid0600/newline; missing; malformed; directory; symlink to another dummy key;0644;129 bytes; fd cleanup; source inode/content/mode/mtime unchanged; no file created on failure; sentinel path/key omitted from errors.
- [ ] Run `node --test apps/server/test/provider-secret-key.test.ts`; observe missing-loader failures.
- [ ] Implement bounded loader and reuse Task1 codec; clear loader-owned temporary buffers on exit. No automatic startup integration, environment fallback or installer mutation.
- [ ] Run focused tests/full relevant tests and TypeScript, diff gates and commit.

## Task3: Configuration JSON and migration preflight boundary

**Interfaces:** `SecretConfigs(codec)` with `encrypt(value:Record<string,unknown>):string`, `decrypt(token:string):Record<string,unknown>`, `verifyLegacyRecord({source:'workspace'|'mount'|'site-ai'|'site-google-oauth'|'site-identity-oauth',id:string,encrypted:string}):{source,id,state:'verified'|'empty'}`. Only empty site configuration strings yield empty; empty workspace/mount tokens fail. Stable INVALID_SECRET_CONFIG for malformed JSON, non-object top level, cyclic/unsupported input, UTF8 corruption or invalid record identity; inherited/toJSON behaviour may not silently replace caller data. Unknown own JSON keys survive. No authenticated configuration or ciphertext is returned by the verifier.

- [ ] Write tests: Python wiki.crypto JSON shapes for Workspace/MountPoint/site AI/OAuth, nested unknown fields, Unicode, null/arrays as values; round-trip in both runtimes; wrong key/corruption/oversize retained source; empty-site-only rule; arrays/null/prototype-sensitive own keys safely preserved without prototype mutation; JSON/toJSON/cycle/invalid UTF8 rejection; result/error redaction and unchanged input record.
- [ ] Run `node --test apps/server/test/provider-secret-config.test.ts`; observe missing-config boundary failures.
- [ ] Implement bounded JSON object validation and per-record verification without provider IO, DB mutation, logging, array materialization of an installation or HTTP scanning endpoint. Return fresh own-property data. Keep secrets internal to this explicit service.
- [ ] Run full native server/web suite, both typechecks/build as affected, Python interoperability, diff gates and commit. Record counts/limits/sources and continue the provider connection/delivery plans. Do not mark the full rewrite or live provider migration complete.

## Protocol sources checked 2026-11-01

- [Official Fernet specification](https://github.com/fernet/spec/blob/master/Spec.md).
- [Python cryptography Fernet documentation](https://cryptography.io/en/latest/fernet/).

Self-review: this plan covers only the encrypted-configuration prerequisite to approved provider/migration stages. It deliberately has no external account operation, token refresh, grants or document write. Public account flows/warnings and the adapters remain later executable plans under the same approved roadmap.
