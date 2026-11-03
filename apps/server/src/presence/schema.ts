export const presenceMigration=`
CREATE TABLE document_presence (
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 browser_session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 client_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 selection TEXT NOT NULL,updated_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 PRIMARY KEY(document_id,browser_session_hash,client_id)
);
CREATE INDEX document_presence_expiry ON document_presence(expires_at);
`;
