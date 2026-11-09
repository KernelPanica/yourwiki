export const googleWatchMigration=`
CREATE TABLE provider_google_watches (
 document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL REFERENCES provider_connections(id),connection_revision INTEGER NOT NULL,
 binding_generation INTEGER NOT NULL,reference TEXT NOT NULL,channel_id TEXT NOT NULL UNIQUE,
 token_hash TEXT NOT NULL,resource_id TEXT,expires_at INTEGER NOT NULL DEFAULT 0,
 retry_at INTEGER NOT NULL,last_number TEXT NOT NULL DEFAULT '0',notified_at INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,error_code TEXT
);
CREATE INDEX provider_ingress_activity_proof ON provider_ingress_snapshots(document_id,observed_fingerprint,binding_generation,connection_revision) WHERE state='applied';
`;
