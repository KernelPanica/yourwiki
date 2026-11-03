/** Append as migration 49; never rewrite earlier migrations. */
export const contentParityMigration = `
CREATE TABLE content_reviews (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 author_id TEXT NOT NULL REFERENCES users(id), author_label TEXT NOT NULL DEFAULT '',
 kind TEXT NOT NULL CHECK(kind IN ('comment','suggestion')), body TEXT NOT NULL,
 anchor TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','rejected','accepted')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX content_reviews_document ON content_reviews(document_id,created_at,id);
CREATE TABLE content_attachments (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 author_id TEXT REFERENCES users(id) ON DELETE SET NULL, name TEXT NOT NULL, content_type TEXT NOT NULL,
 digest TEXT NOT NULL CHECK(length(digest)=64), size INTEGER NOT NULL CHECK(size>=0), created_at INTEGER NOT NULL
);
CREATE INDEX content_attachments_document ON content_attachments(document_id,created_at,id);
CREATE TABLE content_ai_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), encrypted_config TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0)
);
INSERT INTO content_ai_settings(id) VALUES(1);
CREATE TABLE content_ai_requests (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 token TEXT NOT NULL, expires_at INTEGER NOT NULL, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL CHECK(attempts>=0)
);
`;
