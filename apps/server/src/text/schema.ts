export const textWorkspaceMigration=`
CREATE TABLE dashboard_document(id INTEGER PRIMARY KEY CHECK(id=1),document_id TEXT NOT NULL REFERENCES documents(id),legacy_revision INTEGER NOT NULL,created_at INTEGER NOT NULL);
`;
