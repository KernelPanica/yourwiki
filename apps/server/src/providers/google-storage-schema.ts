export const googleStorageMigration=`
CREATE TABLE google_application_settings(id INTEGER PRIMARY KEY CHECK(id=1),encrypted_config TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE google_root_reservations(connection_id TEXT NOT NULL REFERENCES provider_connections(id),account_id TEXT NOT NULL,reference TEXT NOT NULL,PRIMARY KEY(connection_id,account_id));
CREATE TABLE google_storage_mounts(connection_id TEXT PRIMARY KEY REFERENCES provider_connections(id),actor_id TEXT NOT NULL REFERENCES users(id),group_id TEXT NOT NULL REFERENCES groups(id),connection_revision INTEGER NOT NULL,next_scan_at INTEGER NOT NULL DEFAULT 0,queue_json TEXT NOT NULL DEFAULT '[]',discovery_id TEXT,error_code TEXT,scanned_at INTEGER);
`;
export const googleStorageExportsMigration=`
CREATE TABLE google_storage_exports(document_id TEXT PRIMARY KEY REFERENCES documents(id),connection_id TEXT NOT NULL REFERENCES provider_connections(id),actor_id TEXT NOT NULL REFERENCES users(id),revision INTEGER NOT NULL,reference TEXT,destination TEXT,state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','dispatched','confirmed')),next_attempt_at INTEGER NOT NULL DEFAULT 0,error_code TEXT);
CREATE TABLE google_storage_folder_exports(resource_id TEXT PRIMARY KEY REFERENCES resources(id),connection_id TEXT NOT NULL REFERENCES provider_connections(id),reference TEXT NOT NULL,destination TEXT NOT NULL);
CREATE TRIGGER google_storage_export_version BEFORE INSERT ON document_versions WHEN NEW.revision>1 AND EXISTS(SELECT 1 FROM google_storage_exports WHERE document_id=NEW.document_id AND state!='confirmed') BEGIN SELECT RAISE(ABORT,'Google initial upload pending'); END;
`;
