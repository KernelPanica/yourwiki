# rclone originals without permanent local replicas

This mode reads confirmed current binary documents from the existing rclone Drive mount. It does not create an archive folder or upload another copy to Drive.

Local storage contains the application database, keys, ACL/settings, independent attachments and recovery data, pending uploads until remote confirmation, derived previews and temporary processing files. Processing snapshots expire after five minutes. The rclone VFS cache has a 256 MiB target and a five-minute age; open files may temporarily exceed that soft target.

## Preconditions

- Linux/rootful Docker with the existing rclone overlay and shared-mount preparation.
- An authorized, mounted Google connection and a completed initial catalogue scan.
- Local YourWiki version history disabled. The database prevents enabling local history together with direct-original mode. Cloud version history is unaffected.
- A protected metadata backup, including encryption key, installation configuration and deployment environment.

Native Google documents must complete the existing native-to-binary cutover before their local payload can be evicted. Unconfirmed or unavailable originals are retained.

## Activation

Inside the web container, using the actual workspace path:

```sh
node /app/apps/server/src/storage/originals-main.ts plan /data/workspace
node /app/apps/server/src/storage/originals-main.ts enable /data/workspace
```

Restart web/provider/conversion after activation. The private marker `storage/rclone-originals.json` persists across container replacement and reboot. Startup remains dependent on rclone readiness.

Run verified duplicate cleanup:

```sh
node /app/apps/server/src/storage/originals-main.ts evict /data/workspace
```

The provider worker subsequently evicts new confirmed duplicates automatically. It preserves staged saves, unbound/unconfirmed current documents sharing a digest, attachments, recovery copies and retained history.

Bulk maintenance checks a fresh scoped rclone catalogue; ordinary document reads use per-file checks. Full reads verify SHA-256 and postflight metadata. Seekable consumers receive a verified private temporary snapshot instead of a mutable FUSE path.

## Legacy binary references

`evict-legacy` verifies old non-Office originals through an active rclone account, downloads into the temporary processing cache, checks exact SHA-256 and commits an external reference before removing a local replica. Missing originals, mismatched bytes, pending work and shared local-only references are retained. Existing objects on Drive are never modified. Registered references outside the current mount root use rclone `backend copyid` with a local cache destination.

```sh
node /app/apps/server/src/storage/originals-main.ts evict-legacy /data/workspace
```

## Obsolete local Office history

Only when the owner has explicitly accepted losing obsolete local Office versions:

```sh
node /app/apps/server/src/storage/originals-main.ts discard-office /data/workspace --acknowledge-local-office-history-loss
```

This additionally requires a fresh read-only rclone query to confirm that a corresponding original is accessible in an active Google account. Missing/unverified originals are skipped. Disabled connections alone never make an unconfirmed edit discardable. Metadata, users, ACL and cloud objects are preserved.

Receipts are committed before guarded local unlink, so interrupted cleanup is repeatable. The final database transaction rechecks shared references and file identity. There is no remote delete operation in either cleanup command.

## Backups and recovery

Backups explicitly include `externalOriginals: true` in their manifest. They preserve application state, pending payload and external references; they do **not** snapshot the contents of Drive. Restore retains the existing fencing behavior: browser sessions are revoked and external connections disabled until reauthorized.

Missing staged/current local-only data still fails verification even if an old external or discard receipt has the same digest. Temporary processing snapshots are excluded from backups.

Do not remove the mode marker to roll back: local originals have already been evicted. Rehydrate required current payloads first, or keep the direct-original runtime and repair the Drive connection.

## Verification

```sh
node apps/server/test/rclone-originals.test.ts
```

The committed direct-original suite covers cloud reads, stale/unavailable source rejection, pending edits, shared-digest protection, verified local eviction, missing/corrupt sources, processing snapshots, upload namespaces, backup external references and disabled local history.

Development validation additionally ran the existing BlobStore and workspace backup/restore regression suites.
