/** Central identity binds sessions without rewriting user IDs or the legacy session-method CHECK. */
export const yourspaceLoginMigration=`
CREATE TABLE IF NOT EXISTS yourspace_identities (
 issuer TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(issuer,subject),UNIQUE(issuer,user_id)
);
CREATE TABLE yourspace_login_states (
 state_hash TEXT PRIMARY KEY,browser_hash TEXT NOT NULL,encrypted_context TEXT NOT NULL,expires_at INTEGER NOT NULL
);
CREATE TABLE yourspace_sessions (
 token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
 issuer TEXT NOT NULL,subject TEXT NOT NULL,encrypted_token TEXT NOT NULL,checked_at INTEGER NOT NULL
);
CREATE INDEX yourspace_login_expiry ON yourspace_login_states(expires_at);
CREATE TRIGGER yourspace_purge_identity AFTER UPDATE OF purged_at ON users WHEN NEW.purged_at IS NOT NULL BEGIN
 DELETE FROM yourspace_identities WHERE user_id=NEW.id;
END;
`;
