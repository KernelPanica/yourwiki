export const googleReconciliationMigration=`
CREATE TABLE provider_google_reconciliations (
 discovery_id TEXT PRIMARY KEY REFERENCES jobs(id),
 connection_id TEXT NOT NULL REFERENCES provider_connections(id),
 connection_revision INTEGER NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id),
 job_id TEXT NOT NULL REFERENCES jobs(id),
 canonical_id TEXT REFERENCES provider_google_reconciliations(discovery_id),
 cursor TEXT NOT NULL DEFAULT '',
 checked INTEGER NOT NULL DEFAULT 0,
 missing INTEGER NOT NULL DEFAULT 0,
 restored INTEGER NOT NULL DEFAULT 0,
 skipped INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 finished_at INTEGER
);
CREATE INDEX provider_google_reconciliations_connection ON provider_google_reconciliations(connection_id,created_at);
`;
