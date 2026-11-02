# Google worker OAuth verification

Scope: approved Google provider plan Tasks1–2, central-account bearer refresh and internal worker lifecycle. No Google file adapter, native document round trip, consent UI, grants/discovery/trash/restore or real Google account acceptance is established by this report. The whole rewrite remains active; production still uses the existing runtime.

## Persistent authority and refresh outcome

`OAuthConfigs` returns worker-only copied credentials from a current enabled Google connection. Its lease fences semantic revision/ciphertext changes. Routine refresh saves only encrypted configuration while preserving unknown legacy fields, source connection revision/change events and timestamp. A synchronous companion transition makes ciphertext and request completion one transaction; in-memory credentials publish after commit. An outer transaction cannot undo a receipt after the lease has published a new in-memory token.

Append36 adds one current OAuth refresh request per connection. States reserved/dispatched/complete/unknown and a60s owner lease are enforced by SQL guards. A live/unknown dispatched request for the same refresh token cannot be replaced by a label or client-secret revision. Expired never-dispatched reservations are reclaimable; expired dispatched outcomes become unknown. Explicitly provisioned different refresh credentials permit a new request. Only a private SHA256 identity hash of the high-entropy refresh token is stored beside encrypted config; neither it nor request-owner material is in HTTP/SSE/view metadata.

Actual SIGKILL tests exercise reserved, dispatched-marker and accepted boundaries, with verified owner death before advancing the synthetic clock. These are durable lifecycle tests, not a claim that the marker fixture contacted Google. They prove safe reservation recovery, unknown retention without blind reissuance and accepted credential survival across process death. Populated schema31–35 upgrades preserve sources/technical attribution/pending snapshots/quota/jobs/checks/actions/checksums/FKs over reopen.

## Bounded token exchange

`GoogleTokens` uses one fixed Google HTTPS token endpoint, form refresh grant, manual redirect handling,<=30s whole exchange/body deadline and<=64KiB/65536-chunk fatal-UTF8 JSON parsing. It never automatically repeats a POST. Known complete OAuth errors without credential fields are resolved unchanged-token responses; transport failure/redirect/truncated or contradictory response is unknown and remains fenced.

Parallel callers share one in-process exchange. A cancelled waiter does not cancel another waiter or discard issued credentials. A returned valid refresh token is durably saved before access is released, even if the access fields/lifetime are unusable. Expiry begins before exchange and includes a safety margin; slow/short-lived tokens are never extended. Matching-token invalidation does not erase a newer token. Current caller rights and exact returned-cache identity are checked again after async waits. Close cancels transport and even a pre-refresh async authority wait; its completion can be awaited before closing SQLite.

Native owned loopback HTTP tests verify real form POST, success, no redirect follow, stalled-body deadline,401 invalid-client and malformed JSON. Controlled transport tests cover concurrent callers, known/unknown outcome, oversized/empty chunks, issued credential preservation, slow/short lifetime, stale invalidation, current config changes, cancellation/shutdown and static secret-free errors. No real Google credential or Google network request was used.

## Worker-owned cache and capabilities

`CredentialVault.google(connection)` accepts only an object minted by that exact vault. A private WeakMap retains canonical connection identity and a fresh document/binding/config/author authority check. Cloned/foreign objects cannot borrow auth; altering a copied configuration cannot replace the database credential used by OAuth. The returned adapter capability has access/invalidate only, no shared close method.

The pool defaults to32 connections (internal configurable bound1–256), with idle LRU eviction. It pins callers through async authority checks and does not evict in-flight refreshes merely to admit another connection. Retiring HTTP clients count against admission until drained. An evicted idle scope can borrow a fresh client later. Outgoing author revocation cannot use/invalidate the shared token, while another trusted incoming binding can still synchronize without an invented active human.

An actual DeliveryWorker test borrows the minted capability through its normal lease/attempt path and uses the same cached token from a later adapter instance; its file adapter is owned synthetic test code, not Google Drive. The real Local worker CLI still passes source import and SIGTERM cleanup; CLI now awaits vault shutdown before database/key closure. Cached source/API metadata paths perform no token requests, and Google file providers remain unenabled until their own adapters are implemented and verified.

## Regression gates and limits

Initial integration gate: native741/741, web158/158,0skip/0cancelled; both typechecks/build pass. Additional native401/malformed protocol cases pass5/5; final complete server743/743,0failed/0cancelled/0skipped in60432ms and server types pass (`/tmp/yourwiki-google-vault-server-final.log`). Logs `/tmp/yourwiki-google-vault-server.log`, `/tmp/yourwiki-google-vault-web.log`, `/tmp/yourwiki-google-vault-build.log`.

No browser source or animation/dependency changes. No whole-page500ms,2CPU/4GiB/15-user/device/Safari or4GiB Google-native export claim. Unknown refresh after a genuinely ambiguous outage may require reauthorization; local prepared documents remain readable. Root/ownership/type/version enforcement and native Google preservation, public reconnect status/UI, provider grants and actual Google acceptance remain tasks of the continuing provider plan. No push/deploy/cutover is included.

Tasks1–2 complete for this scoped worker OAuth foundation. Tasks3–6 and the full approved rewrite remain active. SQL36 unchanged fromd276074; no source or public frontend flow was enabled by this checkpoint.
