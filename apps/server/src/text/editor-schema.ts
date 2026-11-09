export const markdownEditorMigration=`
CREATE TABLE markdown_saved_replies (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,body TEXT NOT NULL,
 created_at INTEGER NOT NULL,deleted_at INTEGER
);
CREATE INDEX markdown_saved_replies_user ON markdown_saved_replies(user_id,deleted_at);
CREATE TRIGGER markdown_saved_replies_cap BEFORE INSERT ON markdown_saved_replies WHEN
 (SELECT count(*) FROM markdown_saved_replies WHERE user_id=NEW.user_id AND deleted_at IS NULL)>=50
 BEGIN SELECT RAISE(ABORT,'Saved reply limit');END;
`;
