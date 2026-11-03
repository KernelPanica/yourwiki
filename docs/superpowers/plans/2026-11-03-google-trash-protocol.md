# Google trash protocol — Task6 implementation brief

Parent: `2026-11-02-google-provider.md`, approved stage1. Base0025b0a. Execute inline; whole roadmap remains active.

Scope of this checkpoint: verified owned/root-scoped metadata for an explicitly trashed bound document, plus one-shot fixed-origin Drive metadata PATCH for the boolean trash flag. No permanent DELETE, content mutation, new provider resolver activation or false local-trash completion claim. Follow with durable intent/readback worker/local state and UI; those are still required for end-to-end acceptance.

- [x] RED: existing read metadata cannot inspect a trashed original; introduce a separate lifecycle read with explicit-vs-inherited trash evidence. Ordinary source reads must remain strict.
- [x] GREEN: live local check, configured root ownership/ancestry/managed sharing, native type/ID/version checks, allow only target document trash. Parents/root still live, repeated scope checks. No404/network→deletion inference.
- [x] RED: missing trash writer; one-shot exact boolean-only PATCH, before-dispatch hook, strict response and private execution receipts, no automatic retry after unknown/401/5xx, bounded body/deadline/concurrency/close and late-result fencing.
- [x] GREEN: implement protocol; actual owned HTTP and refusal/unknown/cancellation cases. Assert no DELETE, content bytes, field/URL overrides or source writeback claim.
- [x] Focused existing metadata/read/native protocol regressions; server types/full native; document results/ledger and checkpoint. Historical schema stays unchanged.

Reference checked2026-11-03: https://developers.google.com/workspace/drive/api/guides/delete documents files.update trashed=true/false and owner requirement. https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update documents PATCH semantics changing only supplied fields. These are not evidence of a conditional content-upload CAS or deletion inferred from404. Durable dispatch/reconciliation remains mandatory before production activation.

Verified: native1052/1052,focused67/67 plus final metadata/trash29/29,server types pass. See `docs/audits/2026-11-03-google-trash-protocol-verification.md`. This completes this protocol-only checkpoint; it does not complete Task6 or activate Google trash UI/worker. Next durable intent, current-role/binding/config fences, remote readback and local trash/restore composition. An observed matching boolean alone must not be treated as proof an earlier unknown HTTP request is quiescent before an opposite intent. Investigate an attempt marker or retain uncertainty; never silently replay or clear it.
