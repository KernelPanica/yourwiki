# Task2 stage 5: changed Google Sheets ranges

Continue the authorized task2 implementation. Existing Google sheet IDs remain stable.

- Add a pure ODS diff planner: match sheets by title/order; group adjacent changed cells into updateCells ranges; values/formulas and supported format properties get precise field masks. Preserve unrelated remote metadata. Structural changes retain the existing same-ID ODS import path, selected before any mutation.
- Route existing table saves through a provider hook; other providers keep portable ODS. Google checks ownership and source version, fetches sheet IDs and sends one atomic Sheets batch. No import fallback after a failed/ambiguous API write.
- Test changed/cleared cells, formulas, styles, unchanged cells, source conflicts and API failure. Run server suite and document Sheets API setup and remaining structural optimization.

Official contracts: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate and https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request . Existing drive.file scope is accepted; Google Sheets API must be enabled in the OAuth project.

## Continued: native dimensions

Use ordered stable CRDT axis IDs, emitted as `_axes` in the portable table snapshot. Keep the last acknowledged axis map in `Collaboration.saved_structure` (metadata only); update it only after successful provider save, never when staging edits. Rooms created from original files start with canonical IDs. Existing rooms without the new baseline may save ordinary cells but must explicitly reload before structural edits.

Generate insertDimension/deleteDimension/moveDimension and remap old cell coordinates before computing sparse changes. Combine structural and cell requests in one atomic batch, preserving provider-only notes/validation. Keep remote grid tails outside the editor's represented axes intact. Reject ambiguous/untracked structure rather than guessing insertion points. Tests cover mixed operations, stable IDs across retries/restarts, protected baseline on failures, and provider notes following rows.


Implemented and covered by regression tests: native dimension operations, acknowledged session baseline, retry/restart continuation, provider-only note movement, precise merge ranges, native Undo identities and real UI undo paths. ODS blank grid dimensions now survive metadata-free export. Remaining stage-5 work: native sheet topology and filter persistence/full formatting audit. Production migration and live-provider checks remain pending.
