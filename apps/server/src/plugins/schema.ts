/** Version 67: trusted TypeScript service plugins. */
export const pluginsMigration=`
CREATE TABLE service_plugins (
 id TEXT PRIMARY KEY,source TEXT NOT NULL,manifest TEXT NOT NULL,
 encrypted_config TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 last_run_at INTEGER,last_duration_ms INTEGER,last_error TEXT,
 created_by TEXT NOT NULL REFERENCES users(id)
);
`;
