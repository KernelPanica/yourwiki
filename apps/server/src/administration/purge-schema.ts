/** Offline cleanup is separate from the irreversible access tombstone. */
export const resourcePurgeCleanupMigration = `
CREATE TABLE resource_purge_cleanup (
 resource_id TEXT PRIMARY KEY REFERENCES resource_tombstones(resource_id),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','blocked','complete')),
 error_code TEXT,completed_at INTEGER
);
INSERT INTO resource_purge_cleanup(resource_id) SELECT resource_id FROM resource_tombstones;
CREATE TABLE resource_purge_blobs (
 digest TEXT PRIMARY KEY CHECK(length(digest)=64 AND digest NOT GLOB '*[^a-f0-9]*')
);
`;
