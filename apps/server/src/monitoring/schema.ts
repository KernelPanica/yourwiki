/** Append-only migration 64. Operational telemetry never contains request bodies or secrets. */
export const monitoringMigration = `
CREATE TABLE monitoring_samples(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at INTEGER NOT NULL,data TEXT NOT NULL);
CREATE INDEX monitoring_samples_time ON monitoring_samples(created_at);
CREATE TABLE monitoring_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at INTEGER NOT NULL,level TEXT NOT NULL,method TEXT NOT NULL,route TEXT NOT NULL,status INTEGER NOT NULL,duration_ms REAL NOT NULL,code TEXT,request_id TEXT NOT NULL,actor_id TEXT);
CREATE INDEX monitoring_logs_time ON monitoring_logs(created_at);
CREATE INDEX monitoring_logs_level ON monitoring_logs(level,id);
CREATE INDEX administration_audit_time ON administration_audit(created_at,id);
`;
