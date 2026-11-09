export const backupMigration=`
CREATE TABLE provider_backup_settings(id INTEGER PRIMARY KEY CHECK(id=1),connection_id TEXT REFERENCES provider_connections(id),prefix TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 0);
INSERT INTO provider_backup_settings(id) VALUES(1);
CREATE TABLE provider_backups(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES provider_connections(id),connection_revision INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('running','confirmed','error')),reference TEXT,digest TEXT,size INTEGER,error_code TEXT,created_at INTEGER NOT NULL);
`;
