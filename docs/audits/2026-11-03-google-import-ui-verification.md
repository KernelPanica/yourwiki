# Google import controls verification — 2026-11-03

Base:83cddc9. This checkpoint remains inside Google Task6; the overall Google stage and ordered roadmap are incomplete.

## Change

Configured current-Gigaadmin accounts advertise optional `googleImport`. Settings threads that capability into discovery; older or reduced runtimes do not gain unusable controls. Explicit selection of a non-folder discovery result opens an import form with a local title and local destination metadata. A mounted folder inherits its rights; a root mount requires choosing an existing group by name. Group metadata is paginated, never supplied by Google. This first UI uses the configured mount destination; choosing arbitrary descendants is still an outstanding folder-picker feature.

Two DB-only GET endpoints provide current destination/group labels and the current actor's import tasks. Receipts include the original admission nonce so a lost POST acknowledgment can reconcile via history without another POST. A same-operation explicit retry retains the exact nonce and payload when no matching history item is available. Other imports are blocked while the admission result is unknown. No source hash, private namespace, provider continuation, token or credential enters these DTOs.

The browser observes bounded background progress for up to two minutes and provides an explicit status check afterward. Reload recovers tasks through GET only. Only `ready` tasks expose a validated local document link; queued/receiving/staged/preparing/failed-preview tasks do not. Session/role/configuration fences discard late responses and clear destination choices and private task names. Static errors distinguish size, quota, storage, changed original, duplicate/in-progress import and unsupported previews. No localStorage/sessionStorage task persistence or added dependency.

## Evidence

- Initial missing-client RED: `/tmp/yourwiki-google-import-ui-client-red.log`; client7/7: `/tmp/yourwiki-google-import-client-final.log` (explicit admission, exact lost-ACK retry, GET reload recovery, session and role fences, strict response validation, read-only automatic polling, disposed clients).
- Destination metadata missing-method RED: `/tmp/yourwiki-google-import-ui-api-red.log`; metadata/HTTP focused2/2: `/tmp/yourwiki-google-import-ui-api-extra.log`; extra other-Giga isolation/mounted-folder scope1/1: `/tmp/yourwiki-google-import-ui-scope.log`.
- Full native1032/1032,zero fail/cancel/skip,139860ms: `/tmp/yourwiki-google-import-ui-server-full.log`. The extra scope case was added and passed separately afterward; this is not a full1033 claim. No server production changes followed the full run.
- Full web187/187,zero fail/cancel/skip: `/tmp/yourwiki-google-import-web-final.log`. Includes two deferred module-preload tests already present in the workspace; those performance changes are excluded from this checkpoint.
- Server and web typechecks: `/tmp/yourwiki-google-import-server-types-final.log`, `/tmp/yourwiki-google-import-web-types-final.log`.
- Normal build: `/tmp/yourwiki-google-import-ui-build.log`. Independent current-source build using the committed HEAD build script, excluding deferred performance dependencies: `/tmp/yourwiki-google-import-committed-build-final.log`.
- Actual mobile Chromium + configured npm app + owned Google HTTP + actual import and LibreOffice preview workers: `/tmp/yourwiki-google-import-browser-final.log`. Lost ACK accepted server-side then reconciled with GET and no second POST; preparing has no document link; reload retains task; real DOCX preview publication unlocks opening; cached document open makes no provider request; subsequent role revocation clears task/link. Mobile393×852,no horizontal overflow/page errors. Initial fixture lacked import-worker control and timed out as expected: `/tmp/yourwiki-google-import-browser-red.log`.
- Existing discovery and strict-cookie OAuth browsers: `/tmp/yourwiki-google-import-discovery-regression.log`, `/tmp/yourwiki-google-import-connect-regression.log`.
- Screenshots: `output/playwright/google-import-mobile-form.png`, `output/playwright/google-import-mobile-ready.png` (ignored output artifacts).

No schema changes. No live Google credentials or account requests; no real-provider, Collabora, 4GiB transfer, target hardware, iOS, Docker release, migration/restore/Git upgrade or500ms acceptance claim. Google safe writeback/native editing/grants/create/move/trash/restore and other unfinished requirements remain open. No push, merge or deploy.
