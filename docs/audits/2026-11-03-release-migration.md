# Executable legacy migration and limits, 2026-11-03

`npm run release -- migrate /absolute/new-data-root /absolute/input.json` imports a **stopped standalone backup** to a fresh target. In Docker: `docker compose run --rm maintenance migrate /migration-source/input.json`; the source mount is read-only. The tool never opens the supplied legacy database in write mode: it hashes/copies it, rejects nonempty WAL/rollback sidecars, opens only its private copy, and checks the original digest again before completion. Assets are read from administrator-supplied export paths; the importer never guesses or contacts a cloud provider.

The token-protected setup browser now supports the same offline migration through an absolute server-side manifest path, and verified backup restoration through an absolute backup directory path. Both operations require a fresh data root, share the installer operation lock, and refuse existing workspace data. A blocked migration displays all blocker codes and preserves its private report; the installer cannot run another operation against that preserved stage. Restores revoke copied sessions and disable provider connections pending administrator review. The installer never modifies the supplied source or backup.

Example private input (paths inside the maintenance container):

```json
{
  "version": 1,
  "databasePath": "/migration-source/wiki-backup.sqlite3",
  "secretKeyPath": "/migration-source/secrets/encryption.key",
  "publicUrl": "https://wiki.example.org",
  "assets": {
    "document:00112233-4455-6677-8899-aabbccddeeff": {
      "path": "/migration-source/export/original.md",
      "sha256": "replace-with-the-verified-64-character-lowercase-sha256"
    }
  },
  "privateTrees": [
    {"name":"legacy-secrets","path":"/migration-source/secrets"},
    {"name":"write-journal","path":"/migration-source/write-journal"},
    {"name":"fonts","path":"/migration-source/fonts"}
  ]
}
```

Use `document:<normalized-UUID>`, `attachment:<normalized-UUID>`, `pdf-layer:<normalized-document-UUID>` and `history:<normalized-document-UUID>` asset keys. A literal original reference is a fallback for exports without collisions. Supply distinct typed keys when references repeat across mounts. All expected SHA-256 values must come from the exported bytes; provider fingerprints are a separate concept. Empty known journal/fonts directories must be supplied explicitly; omission is unknown capability and blocks promotion. The secrets tree preserves runtime.json and any original signing material without printing their plaintext. Unknown private tree names may be supplied to preserve further data.

Implemented usable mappings:

- Existing users, exact encoded password hashes, activation/admin/can-invite flags, group IDs and memberships. Numeric IDs become their exact decimal string. The real runtime password verifier is exercised in migration tests. Unsupported algorithms block cutover; no password reset is invented.
- Folder/document UUIDs normalized to canonical UUID representation, parent relationships, owner/group, ACL JSON, inheritance/export/trash flags. Folder cycles and foreign-key errors abort. Names are retained. Documents retain local revision, format, original byte digest and created timestamp. Original graph payloads are not normalized.
- Original files copied into the immutable store. Every copied asset is size/hash checked against both manifest and source. Documents enqueue preview preparation; they are not falsely published before conversion.
- Local provider connections/configurations and mount identity. Each imported local document gets its own copied provider original, verified through the runtime local adapter. Its real local fingerprint binds the exact bytes and revision. Encrypted local root configuration points to the new workspace, never back into the legacy source. Nearest ancestor mount wins.
- Invitation hashes, creator, group links, expiration/usage/revocation; preserved login-attempt state (nonzero attempts block cutover until the old combined account/IP hash semantics are reconciled); site policy/auth/file-limit/history settings; encrypted AI settings.
- Review IDs, author labels, kind/body/status, arbitrary anchor JSON, resolution author and timestamps; attachment UUIDs/MIME/name/digest/size; independent PDF annotation-layer revision/base digest/content digest, with mismatches blocked.
- Streaming history archives through the existing validated history decoder and canonical catalogue, retaining arbitrary metadata, old authors/dates/revisions and exact snapshot bytes. This trusted offline boundary allows import before preview publication.
- Trash identity/details/deleter/time. User active flags and group membership snapshots are transformed to the runtime restore fields. Descendant resources inherit the root's trash state so restoring the root does not strand children.

The complete original SQLite snapshot remains at `legacy/source.sqlite3`, including **all** rows, unknown columns, blobs, CRDT snapshots, sessions, pending payloads and operational records. Selected private trees are copied without executing journals. An archived payload is preservation, not usable migrated runtime state.

The JSON report contains source SHA-256, per-table source/mapped counts and explicit blockers. Missing optional operational tables produce `UNKNOWN_CAPABILITY`, never invented zeros. Missing assets, unknown formats, unsupported password hashes, incompatible settings/provider configurations, pending or otherwise unmapped domain state, nonempty write journal, and remote sources without a freshly verified provider fingerprint prevent promotion. When blocked, a private `migration-<UUID>` directory and report remain for review; `/data/workspace` is never created. Do not manually rename it into production.

## Incomplete contract work

This importer does **not** satisfy the full migration contract yet. In particular, CRDT sessions, live leases, save/office recovery states, provider grants/trash/export restrictions/sync outboxes/deletions, old authenticated Django sessions, provider setup/invite-group scopes and font activation have no complete equivalent mapping here. Their records are retained and nonempty unmapped state blocks cutover. Google/other remote source bindings require a verified external import boundary; user-supplied digests are not accepted as remote fingerprints. Site identity OAuth settings require explicit mapping. Historical frontend metadata needs corpus verification before broad acceptance.

Crash-safe stage publication is implemented, but incremental resume/receipts across interrupted stages are not complete. A failed process may leave a private staging directory; restart refuses to overwrite it. Inspect it and use a separate empty target for a new attempt, preserving all source data. No automatic external originals cleanup, journal replay, grant recreation or deletion is performed.

Tests cover lossless unknown binary recovery preservation, unchanged source bytes, native mappings with a working legacy password verifier, missing-original and checksum failures, verified local source binding after atomic promotion, and duplicate existing-target refusal. A full migrated Django fixture and interrupted/resumed migration matrix remain required before final cutover acceptance.
