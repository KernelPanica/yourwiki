# Architecture remediation implementation plan

> Execute the five user-approved audit remedies with focused independent implementation and integrated verification.

**Goal:** Close the reported architecture gaps in write recovery, sheets, history/PDF, graphics and presence.
**Architecture:** Persist a durable local write intent before provider mutation and reconcile uncertain outcomes by inspecting the original before retry. Keep editor identity metadata separate from document content. Native Sheets operations preserve sheet IDs; PDF annotations use a distinct provider artifact bound to the base digest; one global history setting controls all files. Canvas translations and presence reference stable CRDT identities.
**Spec:** `task2.md`, `docs/task2-progress.md`, and the user's five approved audit remedies.
**Constraints:** Preserve the dirty workspace; official APIs and compatible open-source libraries only. No production migrations/restarts or external permission changes in verification. Keep existing files/history recoverable. SQLite deployment remains one ASGI process until a shared transport is configured.

## Review focus

- Provider commits but reply/DB acknowledgement fails: no blind replay, payload retained and original inspected.
- Rename/reorder/add/delete sheets: stable Google sheet IDs and no ODS replacement.
- Local history overrides cannot defeat the global toggle; existing history stays downloadable.
- Annotation saves cannot replace the base PDF; external base edits invalidate the layer binding.
- Concurrent canvas moves add, unknown Draw.io XML survives, stale presence expires without becoming file content.

## Tasks

- [x] Write contract and durable intent: `wiki/write_journal.py`, `wiki/storage.py`, `wiki/saves.py`, `wiki/file_history.py`, migration0019; uncertain binary/native results, fresh-adapter recovery, rename acknowledgement/SQL rollback/collision tests.
- [x] Native Sheets topology and formatting capabilities: `wiki/sheet_batches.py`, `wiki/file_formats.py`, provider integration; stable IDs, metadata-free style roundtrip and unsupported-change rejection.
- [x] Global history: `history_enabled`, settings UI and author-aware entries; legacy override and retained-download tests.
- [x] PDF layer: `wiki/pdf_models.py`, `wiki/pdf_layers.py`, migration0020 and PDF UI/export; original preservation, stale-base, ACL and retry tests.
- [x] Graphics: XML envelopes and additive Canvas translations; mixed XML and simultaneous drag/cancellation tests.
- [x] Presence: migration0021, `wiki/presence.py`, WebSocket heartbeat + client cursors keyed by stable editor positions; TTL, reconnect, ACL and content isolation tests.
- [x] Integrated server/frontend/browser checks; README/progress document exact guarantees and deployment checks.
