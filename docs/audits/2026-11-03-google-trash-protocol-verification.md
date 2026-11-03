# Google trash protocol verification — 2026-11-03

Base0025b0a; Google Task6 stays incomplete. No public/provider-worker activation in this checkpoint.

Separate `GoogleMetadata.trashState` verifies current owned configured root, target identity/type/version, live parents/ancestry and managed sharing while admitting explicit trash evidence for the target only. `trashed` and `explicitlyTrashed` must be boolean and consistent. It rejects root/folder targets and preserves ordinary strict source-read refusal for trashed files. A positive object response supplies evidence;404, network errors, missing flags, lost authority or changed scope do not imply deletion or restoration. Existing source admission limits remain in force.

`GoogleTrashHttp` snapshots exactly reference+boolean before async auth, changes only `trashed` using fixed-origin metadata PATCH after mandatory caller dispatch hook, and validates bounded identity/flag/version acknowledgment. No content bytes, arbitrary field/endpoint override or permanent DELETE. Current authority checks before/after auth, durable callback and HTTP/body work;30s bounded deadline,4active requests, shutdown/cancellation/body cleanup, no401/write retries. Private one-use execution identities bind positive and definite negative receipts to the exact target/flag/operation; copied receipts or reused operations cannot settle another attempt. A lost/invalid/5xx/redirect result remains unknown after submission.

Protocol reference: [Drive trash/restore](https://developers.google.com/workspace/drive/api/guides/delete) and [files.update](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update), checked2026-11-03. PATCH changes supplied metadata fields; this does not establish a conditional content-upload primitive. The optional [private appProperties mechanism](https://developers.google.com/workspace/drive/api/guides/properties) was researched for subsequent reconciliation but is not implemented or claimed atomic here.

## Verification

- Missing lifecycle-method RED `/tmp/yourwiki-google-trash-metadata-red.log`→all metadata12/12 `/tmp/yourwiki-google-trash-metadata.log`.
- Missing writer module RED `/tmp/yourwiki-google-trash-http-red.log`→writer17/17 within final focused29/29 `/tmp/yourwiki-google-trash-final-focused.log`.
- Metadata/read-HTTP/native-write/trash composition67/67 before3additional protocol tests `/tmp/yourwiki-google-trash-focused.log`.
- Actual owned HTTP trash/restore retains ID, sends only the boolean metadata field, observes synthetic external restoration through verified GET, and rejects ordinary reads while trashed. Another actual HTTP server applies trash then destroys the response: exactly one PATCH and unknown outcome. No live Google account or secret used.
- Invalid input/getters, wrong success identity/flags, malformed/oversized bodies,400/401/403/404/412/429/500/307, quota, pre/post-dispatch authority loss, durable-hook failure, shutdown, one-shot reuse, deadlines and late responses covered.
- Initial TS inference error for an optional cleanup response fixed by explicit current `Response` binding; final types `/tmp/yourwiki-google-trash-types-final.log` pass.
- Full native1052/1052,zero fail/cancel/skip,99156ms `/tmp/yourwiki-google-trash-server-full.log`.
- No schema/frontend/build/runtime/Docker changes. Previous frontend187/mobile import+discovery+OAuth checkpoint remains separately recorded; no new browser or target-hardware claim.

## Required next work

Durable intent/outbox; current actor/resource/binding/config scope; local cached ACL invalidation; readback/unknown handling; API/UI and background queue composition; Google→Yourwiki restore and Yourwiki→Google trash on a real account. A matching current trash boolean is desired-state evidence, not proof that an old unknown request has quiesced before an opposite intent. Do not replay or confirm such an intent solely from that flag. Public activation requires resolving that boundary. Shared-drive/unowned/root/folder trash is not supported by this protocol. All Google write/native/grant/create/move and roadmap acceptance obligations remain open; no push/merge/deploy or500ms claim.
