# Task2: save sessions and conflict handling

**Goal:** Complete the next vertical slice (stage 3 and conflict UX from stage 4).
**Authorization:** User requested continuation of task2.md; preserve the previously implemented RW/OAuth work.
**Architecture:** SaveSession is a durable pending snapshot, not file history. Collaborative edits remain CRDT updates; one room snapshot is staged after each accepted update. Binary/PDF sessions retain the submitted payload until the provider confirms writing. A shared writer enforces current ACL and the original fingerprint. Conflict is terminal until explicit reload/copy, and maintenance never retries it silently.
**Scope:** stages 0–2 are the baseline from the previous change; stages 5–10 remain individually tracked, not declared complete by this slice. Existing editors/providers are retained. Only official APIs and compatible open-source components are used.

- [x] Server session model/migration and tests: durable payload, actor, client ID, base revision/ETag, idempotent acknowledgement; preserve payload on provider failure; block conflict retries and revoked writers.
- [x] Route collaborative flush and PDF through the common writer; source/API saves use the same writer. Update status API and WebSocket state; automatic retry only for transient provider failure.
- [x] Debounced 1.5-second save, explicit/manual and visibility/page-exit flush; keep dirty guard until remote save acknowledgement. Add CSRF-protected HTTP flush fallback for pending WebSocket updates.
- [x] Conflict panel: state that original changed and exit will not save; copy/download local content, save copy, explicit discard/reload. Keep working tab's edits; disable further automatic saves during conflict.
- [x] PDF debounce and conflict state using the same sessions; safe retry and download. Annotation-layer separation and other PDF tools remain stage 6.
- [x] Tests across local/provider mocks, external edit/stale revision, permission revocation, two clients, browser conflict/autosave; build/check/docs and update task2 progress.

Checks: late acknowledgements must not clear newer local edits; disconnects must not report saved; read-only user cannot force provider writes; ignored conflicts cannot resume via pagehide or server maintenance; raw exception text must not expose credentials. Browser unload cannot guarantee a large network upload, so warn when unsaved data remains and persist already acknowledged CRDT snapshots server-side.

Verified: 248 server tests passed, 1 skipped; 6 focused browser scenarios passed. Build, Django checks, migration drift and diff whitespace checks passed. No production migration or live-provider run.
