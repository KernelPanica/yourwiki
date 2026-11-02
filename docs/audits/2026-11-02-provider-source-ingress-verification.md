# Local incoming synchronization verification

Status: Local ingress implementation and explicit browser actions verified; whole rewrite and real provider/device acceptance remain open. Base implementation58fbb13; this checkpoint adds a standalone owned-disk large-file proof, not a production cutover.

## Durable acceptance and editor behavior

- Per-document private inbox reserves before body IO, streams and verifies owned immutable bytes, and retains conflict copies separately from the current source. Current configuration, binding, local/provider baseline, pending writes and editor/session authority are rechecked before acceptance. Incoming provider versions have immutable technical provenance and no invented human author.
- One source slot is shared fairly with outgoing delivery. Local stat probing only avoids unchanged reads; an actual accepted version requires complete byte verification. Scheduling is bounded and persists its cursor/due state; HTTP page/status handlers do not read provider files.
- Cached incoming status is a separate seven-field DTO. Explicit check/apply/discard has CSRF/current access/CAS admission and a durable scoped five-field receipt. The browser sends once, recovers a lost reply by UUID GET, fences account changes and never silently retries a write. Applied historical receipts acknowledge accepted work without replacing a newer version.
- Native ru/en/es controls preserve every existing outgoing conflict/unknown/session warning. Apply is unavailable on a divergent accepted local/provider baseline; private discard explicitly confirms that the current document and remote original remain.
- Actual Local/HTTP/Chromium393px scenario verifies check on a parked conflict, private discard with dropped202ACK, queued apply surviving page reload without another POST, one accepted source version and its new prepared Markdown heading, no outward replacement, and preservation of the exact dirty PDF DOM/value in the other tab with no layer/save/exit write. Log `/tmp/yourwiki-sync-controls-browser.log`; screenshot `output/playwright/provider-delivery-mobile.png` inspected. Test fixture controls are stdin-only, with no HTTP debug routes.

## Actual4GiB native process-death proof

Run explicitly on an owned native-disk directory with at least9GiB spare space:

```sh
node --max-old-space-size=48 apps/server/test/support/provider-ingress-large-transfer.ts /home/kernelpanica/Projects/yourwiki/output/native-ingress
```

An optional third argument selects a smaller smoke size (1048576 was exercised first). The default creates4294967296 actual bytes on disk using bounded64KiB writes; it does not use a sparse file or allocate the whole source in memory. SHA256 `ff88752b89c392f770f8751980ae1fce2c970c8ac6ea219ba98e789d57658890`.

1. A separate48MiB-heap worker streams the original into its reserved private namespace, verifies it, then pauses at the real commit boundary. The parent verifies that its metadata is staged, all4GiB are reserved, the current local/provider revisions remain1, and no new version exists. It SIGKILLs the owner and waits for verified process death before expiring synthetic leases.
2. A new48MiB-heap worker reopens the same snapshot, revalidates the complete remote source, adopts/verifies bytes and atomically accepts revision2. It pauses before private cleanup/queue acknowledgement. The parent SIGKILLs it, verifies an applied durable receipt and still-running pull job, then expires only the dead owner's leases.
3. A third48MiB-heap worker recovers the accepted receipt, cleans its private namespace and acknowledges the original job. It resolves no adapter, reads no provider file and performs no replacement. The snapshot ID and receipt remain identical; the source has exactly one new revision and one technical-origin record with null human author; local/provider revisions both2; no outgoing delivery job is created. Reservation becomes0 only after the namespace disappears.
4. The parent fully verifies the accepted blob SHA/size and checks first32/final257 bytes. The remote original retains its inode/device/mtime/size. The owned8GiB fixture is removed; the parent output directory is empty.

| Process | Peak RSS KiB | JS heap used bytes at boundary |
| --- | ---: | ---: |
| Receive and stage |166192|6865792|
| Revalidate and accept before ACK |168344|7020200|
| Receipt recovery and cleanup |101496|11968264|
| Parent generation and final integrity verification |121836|6454000|

Elapsed151145ms; all processes use `--max-old-space-size=48`. Log `/tmp/yourwiki-native-ingress4g.log`. Maximum observed worker RSS is about164.4MiB, independent of the4GiB source size in this run. JS heap cap is not an OS RSS limit. This verifies streaming reception/recovery, not4GiB Office/PDF editing or a2CPU/4GiB host,15-user concurrency, mobile/Safari, internet latency or500ms whole-page guarantee.

## Checkpoint limits

Incoming subplan Task4 is complete for existing verified bound Local sources; final full regression gates are recorded below. No real Google/OneDrive/GitHub/SMB/SFTP adapter acceptance, provider discovery/trash/restore/grant synchronization or production activation is established here. Those and the remaining approved rewrite modules continue under the overall roadmap. No push or deployment is included in this checkpoint.

## Final regression gate

Native server696/696,0failed/0cancelled/0skipped in65900ms, web158/158,0skipped; both typechecks and final frontend build pass. Logs `/tmp/yourwiki-ingress4g-server.log`, `/tmp/yourwiki-ingress4g-web.log`, `/tmp/yourwiki-ingress4g-build.log`. Browser acceptance above was exercised on58fbb13; this checkpoint changes only the standalone large-file verification harness and documentation. SQL/runtime application code unchanged.
