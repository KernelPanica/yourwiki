/** Version 48. Never edit after deployment; append subsequent migrations instead. */
export const administrationMigration = `
ALTER TABLE users ADD COLUMN trashed_at INTEGER;
ALTER TABLE users ADD COLUMN purged_at INTEGER;
ALTER TABLE users ADD COLUMN can_invite INTEGER NOT NULL DEFAULT 0 CHECK(can_invite IN (0,1));
ALTER TABLE groups ADD COLUMN trashed_at INTEGER;
ALTER TABLE groups ADD COLUMN purged_at INTEGER;
CREATE TABLE user_preferences (
 user_id TEXT PRIMARY KEY REFERENCES users(id), language TEXT NOT NULL DEFAULT 'auto' CHECK(language IN ('auto','ru','en')),
 theme TEXT NOT NULL DEFAULT 'auto' CHECK(theme IN ('auto','light','dark')), animations INTEGER NOT NULL DEFAULT 0 CHECK(animations IN (0,1)),
 avatar TEXT,revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE folder_names(resource_id TEXT PRIMARY KEY REFERENCES resources(id),name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200));
INSERT INTO folder_names SELECT resource_id,title FROM provider_google_folders;
CREATE TABLE invitations (
 id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,creator_id TEXT NOT NULL REFERENCES users(id),
 groups_json TEXT NOT NULL,expires_at INTEGER,max_uses INTEGER NOT NULL CHECK(max_uses>=0),uses INTEGER NOT NULL DEFAULT 0,
 revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),trashed_at INTEGER,purged_at INTEGER,created_at INTEGER NOT NULL
);
CREATE TABLE local_trash (
 id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('resource','user','group','invite')),object_id TEXT NOT NULL,
 name TEXT NOT NULL,details TEXT NOT NULL,deleted_by TEXT NOT NULL REFERENCES users(id),deleted_at INTEGER NOT NULL,
 restored_at INTEGER,purged_at INTEGER
);
CREATE UNIQUE INDEX local_trash_live ON local_trash(kind,object_id) WHERE restored_at IS NULL AND purged_at IS NULL;
CREATE TABLE administration_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0,name TEXT NOT NULL DEFAULT 'YourWiki',description TEXT NOT NULL DEFAULT '',document_limit_bytes INTEGER NOT NULL DEFAULT 4294967296 CHECK(document_limit_bytes BETWEEN 1 AND 4294967296),image_limit_bytes INTEGER NOT NULL DEFAULT 5242880 CHECK(image_limit_bytes BETWEEN 1 AND 16777216));
INSERT INTO administration_state(id) VALUES(1);
CREATE TABLE dashboard(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0,blocks TEXT NOT NULL DEFAULT '[]');
INSERT INTO dashboard(id) VALUES(1);
CREATE TABLE resource_tombstones(resource_id TEXT PRIMARY KEY REFERENCES resources(id),purged_at INTEGER NOT NULL,purged_by TEXT NOT NULL REFERENCES users(id));
CREATE TRIGGER resource_purge_restore BEFORE UPDATE OF trashed ON resources WHEN NEW.trashed=0 AND EXISTS(SELECT 1 FROM resource_tombstones WHERE resource_id=NEW.id) BEGIN SELECT RAISE(ABORT,'RESOURCE_PURGED'); END;
CREATE TRIGGER resource_tombstone_delete BEFORE DELETE ON resource_tombstones BEGIN SELECT RAISE(ABORT,'RESOURCE_PURGED'); END;
CREATE TABLE administration_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TRIGGER last_giga_update BEFORE UPDATE OF active,admin_role ON users
 WHEN OLD.active=1 AND OLD.admin_role='giga' AND (NEW.active!=1 OR NEW.admin_role!='giga') AND NOT EXISTS(SELECT 1 FROM users WHERE id!=OLD.id AND active=1 AND admin_role='giga')
 BEGIN SELECT RAISE(ABORT,'LAST_GIGA'); END;
CREATE TRIGGER last_giga_delete BEFORE DELETE ON users WHEN OLD.active=1 AND OLD.admin_role='giga' AND NOT EXISTS(SELECT 1 FROM users WHERE id!=OLD.id AND active=1 AND admin_role='giga')
 BEGIN SELECT RAISE(ABORT,'LAST_GIGA'); END;
CREATE TRIGGER user_trash_inactive BEFORE UPDATE OF active ON users WHEN NEW.active=1 AND (NEW.trashed_at IS NOT NULL OR NEW.purged_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'TRASHED_ACCOUNT'); END;
`;
