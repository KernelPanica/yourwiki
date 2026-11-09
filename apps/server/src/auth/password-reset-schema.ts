export const passwordResetMigration=`
CREATE TABLE password_reset_links (
 user_id TEXT PRIMARY KEY REFERENCES users(id),token_hash TEXT NOT NULL UNIQUE,
 target_version INTEGER NOT NULL,creator_id TEXT NOT NULL REFERENCES users(id),creator_version INTEGER NOT NULL,
 created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL
);
`;
