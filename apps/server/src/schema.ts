/** Immutable migrations: append new versions, never edit applied SQL. */
const core = `
CREATE TABLE app_state (
  id INTEGER PRIMARY KEY CHECK(id=1), acl_epoch INTEGER NOT NULL DEFAULT 0,
  default_policy TEXT NOT NULL, export_disabled INTEGER NOT NULL DEFAULT 0 CHECK(export_disabled IN (0,1))
);
INSERT INTO app_state(id,default_policy) VALUES(1,
  '{"owner":{"read":true,"write":true},"group":{"read":true,"write":false},"everyone":{"read":false,"write":false}}');
CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  admin_role TEXT NOT NULL DEFAULT 'member' CHECK(admin_role IN ('member','simple','giga')),
  auth_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,group_id)
);
CREATE TABLE resources (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('folder','document')),
  parent_id TEXT REFERENCES resources(id) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  policy TEXT NOT NULL DEFAULT '{}', group_policies TEXT NOT NULL DEFAULT '{}',
  user_policies TEXT NOT NULL DEFAULT '{}', inherit_permissions INTEGER NOT NULL DEFAULT 1 CHECK(inherit_permissions IN (0,1)),
  export_disabled INTEGER NOT NULL DEFAULT 0 CHECK(export_disabled IN (0,1)),
  trashed INTEGER NOT NULL DEFAULT 0 CHECK(trashed IN (0,1)), CHECK(parent_id IS NULL OR parent_id!=id)
);
CREATE INDEX resources_parent ON resources(parent_id);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_version INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE login_attempts (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, window_start INTEGER NOT NULL);
`;

// Triggers make invalidation atomic even across worker/server connections.
const epochTriggers = ['users', 'groups', 'memberships', 'resources'].flatMap(table =>
  ['INSERT', 'UPDATE', 'DELETE'].map(operation => `
CREATE TRIGGER ${table}_${operation.toLowerCase()}_acl AFTER ${operation} ON ${table}
BEGIN UPDATE app_state SET acl_epoch=acl_epoch+1 WHERE id=1; END;`)
).join('\n') + `
CREATE TRIGGER settings_acl AFTER UPDATE OF default_policy,export_disabled ON app_state
BEGIN UPDATE app_state SET acl_epoch=acl_epoch+1 WHERE id=1; END;
`;

const authInvalidation = `
CREATE TRIGGER users_auth AFTER UPDATE OF password_hash,active ON users
WHEN OLD.password_hash != NEW.password_hash OR OLD.active != NEW.active
BEGIN UPDATE users SET auth_version=auth_version+1 WHERE id=NEW.id; END;
`;
const authSettings = `
ALTER TABLE app_state ADD COLUMN session_hours INTEGER NOT NULL DEFAULT 24 CHECK(session_hours BETWEEN 1 AND 720);
ALTER TABLE app_state ADD COLUMN login_attempts INTEGER NOT NULL DEFAULT 10 CHECK(login_attempts BETWEEN 1 AND 100);
ALTER TABLE app_state ADD COLUMN login_window_minutes INTEGER NOT NULL DEFAULT 15 CHECK(login_window_minutes BETWEEN 1 AND 1440);
`;
const jobs = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, dedupe_key TEXT NOT NULL, payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed')),
  available_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 100),
  lease_token TEXT, lease_until INTEGER, error_code TEXT, created_at INTEGER NOT NULL,
  UNIQUE(kind,dedupe_key)
);
CREATE INDEX jobs_claim ON jobs(state,available_at,lease_until);
`;
const documents = `
CREATE TABLE documents (
  id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE RESTRICT,
  title TEXT NOT NULL, format TEXT NOT NULL, local_revision INTEGER NOT NULL DEFAULT 0,
  published_revision INTEGER, provider_revision INTEGER, preview_generation INTEGER NOT NULL DEFAULT 0,
  preview_job_id TEXT REFERENCES jobs(id), created_at INTEGER NOT NULL
);
CREATE TABLE document_versions (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL, digest TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0),
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at INTEGER NOT NULL,
  PRIMARY KEY(document_id,revision)
);
CREATE TABLE previews (
  document_id TEXT NOT NULL, revision INTEGER NOT NULL, manifest_digest TEXT NOT NULL,
  converter_version TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(document_id,revision),
  FOREIGN KEY(document_id,revision) REFERENCES document_versions(document_id,revision) ON DELETE RESTRICT
);
CREATE TABLE preview_manifests (
  manifest_digest TEXT PRIMARY KEY, document_id TEXT NOT NULL, revision INTEGER NOT NULL,
  converter_version TEXT NOT NULL, created_at INTEGER NOT NULL,
  FOREIGN KEY(document_id,revision) REFERENCES document_versions(document_id,revision) ON DELETE RESTRICT
);
CREATE TABLE recovery_copies (
  id TEXT PRIMARY KEY, document_id TEXT REFERENCES documents(id) ON DELETE RESTRICT,
  intended_document_id TEXT NOT NULL, author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  digest TEXT NOT NULL, size INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, document_id TEXT NOT NULL,
  payload TEXT NOT NULL, created_at INTEGER NOT NULL
);
`;
const workerSlots = `
CREATE TABLE worker_slots (
  name TEXT PRIMARY KEY, token TEXT NOT NULL, lease_until INTEGER NOT NULL
);
`;
const uploads = `
CREATE TABLE uploads (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  metadata TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0), chunk_bytes INTEGER NOT NULL CHECK(chunk_bytes>0), offset INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','completed','cancelled','expired')),
  result TEXT, cleanup_at INTEGER, lease_token TEXT, lease_until INTEGER, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX uploads_reservations ON uploads(state,expires_at,owner_id);
CREATE TABLE upload_chunks (
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  offset INTEGER NOT NULL, digest TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>0), storage_id TEXT NOT NULL,
  PRIMARY KEY(upload_id,offset)
);
`;
const pdfLayers = `
CREATE TABLE pdf_layer_versions (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>0), base_revision INTEGER NOT NULL,
  digest TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0),
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at INTEGER NOT NULL,
  PRIMARY KEY(document_id,revision),
  FOREIGN KEY(document_id,base_revision) REFERENCES document_versions(document_id,revision) ON DELETE RESTRICT
);
`;
const saveJournal = `
CREATE TABLE save_operations (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  base_revision INTEGER NOT NULL CHECK(base_revision>0), base_digest TEXT NOT NULL,
  digest TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0),
  state TEXT NOT NULL CHECK(state IN ('staged','saved','conflict','denied')),
  receipt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK((state='saved' AND receipt IS NOT NULL) OR (state!='saved' AND receipt IS NULL))
);
CREATE INDEX save_operations_pending ON save_operations(state,author_id);
`;
const officeSessions = `
CREATE TABLE office_sessions (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
 base_revision INTEGER NOT NULL, base_digest TEXT NOT NULL,
 expires_at INTEGER NOT NULL, superseded INTEGER NOT NULL DEFAULT 0 CHECK(superseded IN (0,1)),
 lock_value TEXT NOT NULL DEFAULT '', lock_expires_at INTEGER NOT NULL DEFAULT 0,
 pending_operation_id TEXT REFERENCES save_operations(id) ON DELETE RESTRICT,
 error_code TEXT, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX office_current ON office_sessions(document_id) WHERE superseded=0;
CREATE TABLE office_tokens (
 token_hash TEXT PRIMARY KEY, office_session_id TEXT NOT NULL REFERENCES office_sessions(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 browser_session_hash TEXT NOT NULL, writable INTEGER NOT NULL CHECK(writable IN (0,1)), expires_at INTEGER NOT NULL
);
CREATE INDEX office_tokens_expiry ON office_tokens(expires_at);
ALTER TABLE save_operations ADD COLUMN office_session_id TEXT REFERENCES office_sessions(id) ON DELETE RESTRICT;
`;
const officeIngress = `
CREATE TABLE office_ingress (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
 office_session_id TEXT NOT NULL REFERENCES office_sessions(id) ON DELETE RESTRICT,
 author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 base_revision INTEGER NOT NULL, base_digest TEXT NOT NULL, lock_value TEXT NOT NULL,
 declared_size INTEGER, reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),
 state TEXT NOT NULL CHECK(state IN ('receiving','prepared','committed','failed','discarded')),
 digest TEXT, size INTEGER, lease_token TEXT NOT NULL, lease_until INTEGER NOT NULL,
 created_at INTEGER NOT NULL, error_code TEXT,
 CHECK((digest IS NULL AND size IS NULL) OR (digest IS NOT NULL AND size>=0))
);
CREATE UNIQUE INDEX office_receiving ON office_ingress(document_id) WHERE state='receiving';
CREATE INDEX office_ingress_budget ON office_ingress(state,author_id);
`;
const officeCleanup = `
CREATE TABLE office_ingress_cleanup (
 id TEXT PRIMARY KEY REFERENCES office_ingress(id) ON DELETE CASCADE,
 token TEXT NOT NULL, lease_until INTEGER NOT NULL
);
ALTER TABLE save_operations ADD COLUMN cancelled_at INTEGER;
CREATE INDEX save_operations_retained ON save_operations(author_id,size) WHERE state!='saved' AND cancelled_at IS NULL;
CREATE INDEX office_ingress_retained ON office_ingress(reserved_bytes,state,author_id)
 WHERE reserved_bytes>0 OR state IN ('receiving','prepared') OR (state='failed' AND digest IS NOT NULL);
`;
const officeRecovery = `
CREATE INDEX office_ingress_recovery ON office_ingress(document_id,id)
 WHERE state='receiving' OR (state IN ('prepared','failed') AND digest IS NOT NULL);
`;
const officePrepared = `
CREATE TABLE office_prepared (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
 source_revision INTEGER NOT NULL, source_digest TEXT NOT NULL, format TEXT NOT NULL, converter_version TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('creating','ready','failed','deleting')),
 digest TEXT, size INTEGER, reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),
 lease_token TEXT NOT NULL, lease_until INTEGER NOT NULL, created_at INTEGER NOT NULL, last_access_at INTEGER NOT NULL, error_code TEXT,
 CHECK((digest IS NULL AND size IS NULL) OR (digest IS NOT NULL AND size>=0))
);
ALTER TABLE office_sessions ADD COLUMN prepared_id TEXT REFERENCES office_prepared(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX office_prepared_current ON office_prepared(document_id,source_revision,source_digest,format,converter_version) WHERE state IN ('creating','ready');
CREATE INDEX office_prepared_cleanup ON office_prepared(state,lease_until,last_access_at);
`;
const officePreparedBindings = `
CREATE INDEX office_sessions_prepared ON office_sessions(prepared_id) WHERE prepared_id IS NOT NULL;
`;
const officeSaveIntents = `
CREATE TABLE office_save_intents (
 tag TEXT PRIMARY KEY, office_session_id TEXT NOT NULL REFERENCES office_sessions(id) ON DELETE CASCADE,
 browser_session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0,1))
);
CREATE INDEX office_save_intents_pending ON office_save_intents(browser_session_hash,confirmed,expires_at);
CREATE INDEX office_save_intents_expiry ON office_save_intents(expires_at);
ALTER TABLE office_ingress ADD COLUMN client_tag TEXT;
ALTER TABLE office_ingress ADD COLUMN committed_revision INTEGER CHECK(committed_revision>=1);
CREATE INDEX office_ingress_client_tag ON office_ingress(office_session_id,client_tag) WHERE client_tag IS NOT NULL;
`;
const officeOpenings = `
CREATE TABLE office_openings (
 browser_session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 open_id TEXT NOT NULL, document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','ready','cancelled')),
 office_session_id TEXT REFERENCES office_sessions(id) ON DELETE SET NULL,
 capability_hash TEXT, created_at INTEGER NOT NULL,
 PRIMARY KEY(browser_session_hash,open_id)
);
CREATE INDEX sessions_csrf_lookup ON sessions(csrf_hash);
CREATE INDEX office_openings_pending ON office_openings(created_at) WHERE state='pending';
`;
const officeHandoff = `
ALTER TABLE office_openings ADD COLUMN handoff_deadline INTEGER;
ALTER TABLE office_openings ADD COLUMN claimed_at INTEGER;
UPDATE office_openings SET claimed_at=created_at WHERE state='ready';
CREATE INDEX office_openings_capability ON office_openings(capability_hash,office_session_id,browser_session_hash) WHERE capability_hash IS NOT NULL;
CREATE INDEX office_openings_handoff ON office_openings(handoff_deadline) WHERE state='ready' AND claimed_at IS NULL AND handoff_deadline IS NOT NULL;
`;
const documentVisits = `
CREATE TABLE document_visits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  opened_at INTEGER NOT NULL CHECK(opened_at>=0),
  PRIMARY KEY(user_id,document_id)
);
CREATE INDEX document_visits_recent ON document_visits(user_id,opened_at DESC,document_id DESC);
`;
const versionHistory = `
ALTER TABLE app_state ADD COLUMN history_enabled INTEGER NOT NULL DEFAULT 0 CHECK(history_enabled IN (0,1));
ALTER TABLE app_state ADD COLUMN history_settings_revision INTEGER NOT NULL DEFAULT 0 CHECK(history_settings_revision>=0);
ALTER TABLE app_state ADD COLUMN history_byte_limit INTEGER NOT NULL DEFAULT 42949672960 CHECK(history_byte_limit>0 AND history_byte_limit<=9007199254740991);
ALTER TABLE app_state ADD COLUMN history_entry_limit INTEGER NOT NULL DEFAULT 100000 CHECK(history_entry_limit>0 AND history_entry_limit<=100000);
CREATE TABLE history_entries (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
 kind TEXT NOT NULL CHECK(kind IN ('source','pdf-layer')),
 source_revision INTEGER NOT NULL CHECK(source_revision>=1),
 layer_revision INTEGER,
 digest TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0),
 title TEXT NOT NULL, format TEXT NOT NULL,
 captured_by TEXT REFERENCES users(id) ON DELETE SET NULL, captured_by_name TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 CHECK((kind='source' AND layer_revision IS NULL) OR (kind='pdf-layer' AND layer_revision IS NOT NULL AND layer_revision>=0))
);
CREATE INDEX history_entries_document ON history_entries(document_id,id DESC);
CREATE TRIGGER history_entries_immutable BEFORE UPDATE OF document_id,kind,source_revision,layer_revision,digest,size,title,format,captured_by_name,created_at ON history_entries BEGIN
 SELECT RAISE(ABORT,'History entries are immutable');
END;
CREATE TABLE history_usage (
 document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
 total_bytes INTEGER NOT NULL CHECK(total_bytes>=0), entry_count INTEGER NOT NULL CHECK(entry_count>=0)
);
CREATE TRIGGER history_usage_insert AFTER INSERT ON history_entries BEGIN
 INSERT INTO history_usage(document_id,total_bytes,entry_count) VALUES(NEW.document_id,NEW.size,1)
 ON CONFLICT(document_id) DO UPDATE SET total_bytes=total_bytes+NEW.size,entry_count=entry_count+1;
END;
CREATE TRIGGER history_usage_delete AFTER DELETE ON history_entries BEGIN
 UPDATE history_usage SET total_bytes=total_bytes-OLD.size,entry_count=entry_count-1 WHERE document_id=OLD.document_id;
 DELETE FROM history_usage WHERE document_id=OLD.document_id AND entry_count=0;
END;
CREATE TABLE history_settings_changes (
 id INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL UNIQUE,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 author_id TEXT REFERENCES users(id) ON DELETE SET NULL, author_name TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
`;
const historyPreviews = `
CREATE TABLE history_preview_generations (
 entry_id INTEGER NOT NULL REFERENCES history_entries(id) ON DELETE CASCADE,
 converter_version TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=1),
 PRIMARY KEY(entry_id,converter_version)
);
CREATE TABLE history_previews (
 id TEXT PRIMARY KEY,
 entry_id INTEGER NOT NULL REFERENCES history_entries(id) ON DELETE RESTRICT,
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
 converter_version TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=1),
 source_digest TEXT NOT NULL, source_size INTEGER NOT NULL CHECK(source_size>=0), format TEXT NOT NULL,
 requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
 job_id TEXT UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
 state TEXT NOT NULL CHECK(state IN ('queued','creating','ready','failed','deleting')),
 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 manifest_digest TEXT, manifest_size INTEGER,
 reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),
 error_code TEXT, created_at INTEGER NOT NULL, last_access_at INTEGER NOT NULL,
 UNIQUE(entry_id,converter_version,generation)
);
CREATE INDEX history_previews_latest ON history_previews(entry_id,converter_version,generation DESC);
CREATE INDEX history_previews_charged ON history_previews(reserved_bytes) WHERE reserved_bytes>0;
CREATE INDEX history_previews_requester ON history_previews(requested_by,state) WHERE state IN ('queued','creating');
CREATE INDEX history_previews_expiry ON history_previews(state,lease_until);
CREATE INDEX history_previews_idle ON history_previews(state,last_access_at);
CREATE TRIGGER history_previews_binding BEFORE UPDATE OF entry_id,document_id,converter_version,generation,source_digest,source_size,format ON history_previews BEGIN
 SELECT RAISE(ABORT,'Historical preview binding is immutable');
END;
`;
const historyRestores = `
CREATE TABLE history_restores (
 id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
 entry_id INTEGER NOT NULL REFERENCES history_entries(id) ON DELETE RESTRICT,
 base_revision INTEGER NOT NULL CHECK(base_revision>=1), base_digest TEXT NOT NULL,
 layer_revision INTEGER NOT NULL CHECK(layer_revision>=0), layer_digest TEXT,
 target_digest TEXT NOT NULL, target_size INTEGER NOT NULL CHECK(target_size>=0),
 format TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('source','pdf-layer')),
 state TEXT NOT NULL CHECK(state IN ('staged','saved','discarded')),
 receipt TEXT, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 CHECK((layer_revision=0 AND layer_digest IS NULL) OR (layer_revision>0 AND layer_digest IS NOT NULL)),
 CHECK((state='saved' AND receipt IS NOT NULL) OR (state!='saved' AND receipt IS NULL))
);
CREATE INDEX history_restores_pending ON history_restores(state,author_id);
CREATE INDEX save_operations_document_pending ON save_operations(document_id) WHERE state!='saved' AND cancelled_at IS NULL;
CREATE INDEX uploads_document_pending ON uploads(json_extract(metadata,'$.documentId'),expires_at) WHERE state='active';
CREATE TRIGGER history_restores_binding BEFORE UPDATE OF author_id,document_id,entry_id,base_revision,base_digest,layer_revision,layer_digest,target_digest,target_size,format,kind ON history_restores BEGIN
 SELECT RAISE(ABORT,'Restore binding is immutable');
END;
`;
const legacyHistory = `
CREATE TEMP TABLE history_sequence_before_rebuild(seq INTEGER);
INSERT INTO history_sequence_before_rebuild SELECT seq FROM sqlite_sequence WHERE name='history_entries';
CREATE TABLE history_entries_rebuilt (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
 kind TEXT NOT NULL CHECK(kind IN ('source','pdf-layer')),
 source_revision INTEGER NOT NULL CHECK(source_revision>=0),
 layer_revision INTEGER,
 digest TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0),
 title TEXT NOT NULL, format TEXT NOT NULL,
 captured_by TEXT REFERENCES users(id) ON DELETE SET NULL, captured_by_name TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 CHECK((kind='source' AND layer_revision IS NULL) OR (kind='pdf-layer' AND layer_revision IS NOT NULL AND layer_revision>=0))
);
INSERT INTO history_entries_rebuilt SELECT * FROM history_entries;
DROP TABLE history_entries;
ALTER TABLE history_entries_rebuilt RENAME TO history_entries;
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM history_sequence_before_rebuild),0)) WHERE name='history_entries';
DROP TABLE history_sequence_before_rebuild;
CREATE INDEX history_entries_document ON history_entries(document_id,id DESC);
CREATE TRIGGER history_entries_immutable BEFORE UPDATE OF document_id,kind,source_revision,layer_revision,digest,size,title,format,captured_by_name,created_at ON history_entries BEGIN
 SELECT RAISE(ABORT,'History entries are immutable');
END;
CREATE TRIGGER history_usage_insert AFTER INSERT ON history_entries BEGIN
 INSERT INTO history_usage(document_id,total_bytes,entry_count) VALUES(NEW.document_id,NEW.size,1)
 ON CONFLICT(document_id) DO UPDATE SET total_bytes=total_bytes+NEW.size,entry_count=entry_count+1;
END;
CREATE TRIGGER history_usage_delete AFTER DELETE ON history_entries BEGIN
 UPDATE history_usage SET total_bytes=total_bytes-OLD.size,entry_count=entry_count-1 WHERE document_id=OLD.document_id;
 DELETE FROM history_usage WHERE document_id=OLD.document_id AND entry_count=0;
END;
CREATE TABLE history_legacy_metadata (
 entry_id INTEGER PRIMARY KEY REFERENCES history_entries(id) ON DELETE CASCADE,
 metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json) AND length(CAST(metadata_json AS BLOB))<=65536)
);
CREATE TRIGGER history_legacy_metadata_immutable BEFORE UPDATE ON history_legacy_metadata BEGIN
 SELECT RAISE(ABORT,'Legacy history metadata is immutable');
END;
`;
const historyImports = `
CREATE TABLE history_imports (
 id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
 source_key TEXT NOT NULL, archive_digest TEXT NOT NULL, archive_size INTEGER NOT NULL CHECK(archive_size>0),
 namespace_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),
 state TEXT NOT NULL CHECK(state IN ('pending','receiving','prepared','committed','failed')),
 reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),
 entry_count INTEGER NOT NULL DEFAULT 0 CHECK(entry_count>=0), total_bytes INTEGER NOT NULL DEFAULT 0 CHECK(total_bytes>=0),
 adoption_started INTEGER NOT NULL DEFAULT 0 CHECK(adoption_started IN (0,1)),
 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 receipt TEXT, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(document_id,source_key,archive_digest),
 CHECK((state='committed' AND receipt IS NOT NULL) OR (state!='committed' AND receipt IS NULL))
);
CREATE INDEX history_imports_reservations ON history_imports(reserved_bytes) WHERE reserved_bytes>0;
CREATE INDEX history_imports_author_pending ON history_imports(author_id,state);
CREATE INDEX history_imports_cleanup ON history_imports(state,lease_until);
CREATE TRIGGER history_imports_binding BEFORE UPDATE OF author_id,document_id,source_key,archive_digest,archive_size ON history_imports BEGIN
 SELECT RAISE(ABORT,'History import binding is immutable');
END;
CREATE TABLE history_import_entries (
 import_id TEXT NOT NULL REFERENCES history_imports(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0), digest TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0),
 metadata_json TEXT CHECK(metadata_json IS NULL OR (json_valid(metadata_json) AND length(CAST(metadata_json AS BLOB))<=65536)),
 entry_id INTEGER UNIQUE REFERENCES history_entries(id) ON DELETE RESTRICT,
 PRIMARY KEY(import_id,ordinal)
);
CREATE TRIGGER history_import_entries_binding BEFORE UPDATE OF import_id,ordinal,digest,size ON history_import_entries BEGIN
 SELECT RAISE(ABORT,'Staged history binding is immutable');
END;
`;
const historyCatalogue = `
CREATE TABLE history_public_sequence (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 value INTEGER NOT NULL CHECK(typeof(value)='integer' AND value>=0 AND value<=9007199254740991)
);
INSERT INTO history_public_sequence SELECT 1,MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='history_entries'),0),COALESCE((SELECT MAX(id) FROM history_entries),0));
CREATE TRIGGER history_public_sequence_monotonic BEFORE UPDATE OF value ON history_public_sequence WHEN NEW.value<OLD.value BEGIN
 SELECT RAISE(ABORT,'History public sequence is monotonic');
END;
CREATE TRIGGER history_public_sequence_delete_guard BEFORE DELETE ON history_public_sequence BEGIN
 SELECT RAISE(ABORT,'History public sequence is permanent');
END;
ALTER TABLE history_entries ADD COLUMN public_id INTEGER CHECK(public_id IS NULL OR (public_id>0 AND public_id<=9007199254740991));
ALTER TABLE history_entries ADD COLUMN import_id TEXT REFERENCES history_imports(id) ON DELETE RESTRICT;
ALTER TABLE history_entries ADD COLUMN import_ordinal INTEGER CHECK((import_id IS NULL AND import_ordinal IS NULL) OR (import_id IS NOT NULL AND import_ordinal IS NOT NULL AND import_ordinal>=0));
UPDATE history_entries SET public_id=id;
CREATE UNIQUE INDEX history_entries_public_identity ON history_entries(public_id) WHERE public_id IS NOT NULL;
CREATE INDEX history_entries_public_document ON history_entries(document_id,public_id DESC) WHERE import_id IS NULL;
CREATE UNIQUE INDEX history_entries_import_ordinal ON history_entries(import_id,import_ordinal DESC) WHERE import_id IS NOT NULL;
ALTER TABLE history_imports ADD COLUMN catalogue_count INTEGER NOT NULL DEFAULT 0 CHECK(catalogue_count>=0 AND catalogue_count<=100000);
ALTER TABLE history_imports ADD COLUMN catalogue_bytes INTEGER NOT NULL DEFAULT 0 CHECK(catalogue_bytes>=0 AND catalogue_bytes<=9007199254740991);
ALTER TABLE history_imports ADD COLUMN catalogue_ready INTEGER NOT NULL DEFAULT 0 CHECK(catalogue_ready IN (0,1) AND (catalogue_ready=0 OR (catalogue_count=entry_count AND catalogue_bytes=total_bytes)));
ALTER TABLE history_imports ADD COLUMN first_public_id INTEGER CHECK(first_public_id IS NULL OR (first_public_id>0 AND first_public_id<=9007199254740991));
ALTER TABLE history_imports ADD COLUMN last_public_id INTEGER CHECK((first_public_id IS NULL AND last_public_id IS NULL) OR (first_public_id IS NOT NULL AND last_public_id IS NOT NULL AND last_public_id>=first_public_id AND last_public_id<=9007199254740991 AND last_public_id-first_public_id+1=entry_count AND state='committed' AND catalogue_ready=1));
CREATE INDEX history_imports_public_document ON history_imports(document_id,first_public_id DESC) WHERE first_public_id IS NOT NULL AND state='committed';
CREATE UNIQUE INDEX history_imports_public_first ON history_imports(first_public_id) WHERE first_public_id IS NOT NULL;
CREATE UNIQUE INDEX history_imports_public_last ON history_imports(last_public_id) WHERE last_public_id IS NOT NULL;
DROP TRIGGER history_usage_insert;
DROP TRIGGER history_usage_delete;
CREATE TRIGGER history_usage_insert AFTER INSERT ON history_entries WHEN NEW.import_id IS NULL BEGIN
 INSERT INTO history_usage(document_id,total_bytes,entry_count) VALUES(NEW.document_id,NEW.size,1)
 ON CONFLICT(document_id) DO UPDATE SET total_bytes=total_bytes+NEW.size,entry_count=entry_count+1;
END;
CREATE TRIGGER history_usage_delete AFTER DELETE ON history_entries WHEN OLD.import_id IS NULL BEGIN
 UPDATE history_usage SET total_bytes=total_bytes-OLD.size,entry_count=entry_count-1 WHERE document_id=OLD.document_id;
 DELETE FROM history_usage WHERE document_id=OLD.document_id AND entry_count=0;
END;
CREATE TRIGGER history_local_public_insert_guard BEFORE INSERT ON history_entries WHEN NEW.import_id IS NULL AND NEW.public_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'Public history identity is allocated internally');
END;
CREATE TRIGGER history_local_public_insert AFTER INSERT ON history_entries WHEN NEW.import_id IS NULL BEGIN
 UPDATE history_public_sequence SET value=MAX(value+1,NEW.id) WHERE singleton=1;
 UPDATE history_entries SET public_id=(SELECT value FROM history_public_sequence WHERE singleton=1) WHERE id=NEW.id;
END;
CREATE TRIGGER history_public_identity_immutable BEFORE UPDATE OF public_id ON history_entries
 WHEN NOT (OLD.public_id IS NULL AND OLD.import_id IS NULL AND NEW.import_id IS NULL AND NEW.public_id=(SELECT value FROM history_public_sequence WHERE singleton=1)) BEGIN
 SELECT RAISE(ABORT,'Public history identity is immutable');
END;
CREATE TRIGGER history_import_identity_immutable BEFORE UPDATE OF import_id,import_ordinal ON history_entries BEGIN
 SELECT RAISE(ABORT,'Canonical import identity is immutable');
END;
CREATE TRIGGER history_import_entry_insert_guard BEFORE INSERT ON history_entries WHEN NEW.import_id IS NOT NULL BEGIN
 SELECT CASE WHEN NEW.public_id IS NOT NULL OR NEW.kind!='source' OR NEW.layer_revision IS NOT NULL OR NEW.captured_by IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM history_imports i JOIN history_import_entries s ON s.import_id=i.id
  WHERE i.id=NEW.import_id AND i.document_id=NEW.document_id AND i.state IN ('pending','receiving','prepared') AND i.catalogue_ready=0
   AND i.catalogue_count=NEW.import_ordinal AND s.ordinal=NEW.import_ordinal AND s.digest=NEW.digest AND s.size=NEW.size AND s.entry_id IS NULL
 ) THEN RAISE(ABORT,'Invalid private import binding') END;
END;
CREATE TRIGGER history_import_map_identity_immutable BEFORE UPDATE OF entry_id ON history_import_entries BEGIN
 SELECT CASE WHEN OLD.entry_id IS NOT NULL OR NEW.entry_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM history_entries e JOIN history_imports i ON i.id=NEW.import_id
  WHERE e.id=NEW.entry_id AND e.document_id=i.document_id AND e.digest=NEW.digest AND e.size=NEW.size
   AND ((e.import_id=NEW.import_id AND e.import_ordinal=NEW.ordinal) OR (e.import_id IS NULL AND i.catalogue_ready=0))
 ) THEN RAISE(ABORT,'Import receipt identity is immutable') END;
END;
CREATE TRIGGER history_import_entry_count_insert AFTER INSERT ON history_entries WHEN NEW.import_id IS NOT NULL BEGIN
 UPDATE history_import_entries SET entry_id=NEW.id WHERE import_id=NEW.import_id AND ordinal=NEW.import_ordinal;
 UPDATE history_imports SET catalogue_count=catalogue_count+1,catalogue_bytes=catalogue_bytes+NEW.size WHERE id=NEW.import_id;
END;
CREATE TRIGGER history_import_entry_delete_guard BEFORE DELETE ON history_entries WHEN OLD.import_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM history_imports WHERE id=OLD.import_id AND state='failed') THEN RAISE(ABORT,'Only failed private import records can be removed') END;
END;
CREATE TRIGGER history_import_entry_count_delete AFTER DELETE ON history_entries WHEN OLD.import_id IS NOT NULL BEGIN
 UPDATE history_imports SET catalogue_count=catalogue_count-1,catalogue_bytes=catalogue_bytes-OLD.size WHERE id=OLD.import_id;
END;
CREATE TRIGGER history_import_legacy_delete_guard BEFORE DELETE ON history_legacy_metadata BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM history_entries e JOIN history_imports i ON i.id=e.import_id WHERE e.id=OLD.entry_id AND i.state!='failed') THEN RAISE(ABORT,'Canonical import metadata is immutable') END;
END;
CREATE TRIGGER history_import_generation_guard BEFORE UPDATE OF namespace_id,generation ON history_imports WHEN OLD.catalogue_count>0 BEGIN
 SELECT RAISE(ABORT,'Canonical import generation is immutable until cleanup');
END;
CREATE TRIGGER history_import_ready_guard BEFORE UPDATE OF catalogue_ready ON history_imports WHEN NEW.catalogue_ready=1 AND OLD.catalogue_ready=0 BEGIN
 SELECT CASE WHEN NEW.state!='prepared' OR NEW.entry_count!=(
  SELECT COUNT(*) FROM history_import_entries s JOIN history_entries e ON e.id=s.entry_id JOIN history_legacy_metadata m ON m.entry_id=e.id
  WHERE s.import_id=NEW.id AND e.import_id=NEW.id AND e.import_ordinal=s.ordinal
 ) THEN RAISE(ABORT,'Incomplete canonical import') END;
END;
CREATE TRIGGER history_import_ready_immutable BEFORE UPDATE OF catalogue_ready ON history_imports
 WHEN OLD.catalogue_ready=1 AND NEW.catalogue_ready=0 AND NOT (NEW.state='failed' AND OLD.adoption_started=0 AND NEW.adoption_started=0) BEGIN
 SELECT RAISE(ABORT,'Canonical readiness is immutable after preparation');
END;
CREATE TRIGGER history_import_adoption_immutable BEFORE UPDATE OF adoption_started ON history_imports
 WHEN OLD.adoption_started=1 AND NEW.adoption_started=0 AND NOT (OLD.state='failed' AND OLD.reserved_bytes=0 AND OLD.catalogue_count=0) BEGIN
 SELECT RAISE(ABORT,'Started adoption is immutable until failed cleanup');
END;
CREATE TRIGGER history_import_public_binding_immutable BEFORE UPDATE OF first_public_id,last_public_id ON history_imports WHEN OLD.first_public_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'Import public range is immutable');
END;
CREATE TRIGGER history_import_publication_guard BEFORE UPDATE OF state ON history_imports WHEN NEW.state='committed' AND OLD.state!='committed' AND NEW.catalogue_ready=1 BEGIN
 SELECT CASE WHEN OLD.state!='prepared' OR NEW.adoption_started!=1 OR (NEW.entry_count>0 AND (
  NEW.first_public_id IS NULL OR NEW.last_public_id!=(SELECT value FROM history_public_sequence WHERE singleton=1)
  OR NEW.first_public_id<=COALESCE((SELECT MAX(public_id) FROM history_entries WHERE public_id IS NOT NULL),0)
  OR NEW.first_public_id<=COALESCE((SELECT MAX(last_public_id) FROM history_imports WHERE last_public_id IS NOT NULL),0)
 )) THEN RAISE(ABORT,'Invalid canonical publication') END;
END;
CREATE TRIGGER history_import_committed_immutable BEFORE UPDATE OF state,receipt,entry_count,total_bytes,catalogue_count,catalogue_bytes ON history_imports WHEN OLD.state='committed' BEGIN
 SELECT RAISE(ABORT,'Committed import metadata is immutable');
END;
CREATE TRIGGER history_import_usage_publish AFTER UPDATE OF state ON history_imports WHEN NEW.state='committed' AND OLD.state!='committed' AND NEW.catalogue_ready=1 BEGIN
 INSERT INTO history_usage(document_id,total_bytes,entry_count) SELECT NEW.document_id,NEW.total_bytes,NEW.entry_count WHERE NEW.entry_count>0
 ON CONFLICT(document_id) DO UPDATE SET total_bytes=total_bytes+NEW.total_bytes,entry_count=entry_count+NEW.entry_count;
END;
`;
const providerConnections = `
CREATE TABLE provider_connections (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
 provider TEXT NOT NULL CHECK(provider IN ('local','google','onedrive','github','smb','sftp')),
 label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 200),
 encrypted_config TEXT NOT NULL CHECK(length(encrypted_config) BETWEEN 1 AND 2097152 AND encrypted_config NOT GLOB '*[^A-Za-z0-9_=-]*'),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE TABLE provider_mounts (
 connection_id TEXT PRIMARY KEY REFERENCES provider_connections(id) ON DELETE RESTRICT,
 path TEXT NOT NULL UNIQUE CHECK(length(path) BETWEEN 1 AND 2048 AND substr(path,1,1)='/'),
 folder_id TEXT UNIQUE REFERENCES resources(id) ON DELETE RESTRICT,
 CHECK((path='/' AND folder_id IS NULL) OR (path!='/' AND folder_id IS NOT NULL))
);
CREATE TRIGGER provider_connection_identity BEFORE UPDATE OF id,provider,created_at ON provider_connections BEGIN
 SELECT RAISE(ABORT,'Provider connection identity is immutable');
END;
CREATE TRIGGER provider_mount_identity BEFORE UPDATE ON provider_mounts BEGIN
 SELECT RAISE(ABORT,'Provider mount identity is immutable');
END;
CREATE TRIGGER provider_mount_folder_insert BEFORE INSERT ON provider_mounts WHEN NEW.folder_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM resources WHERE id=NEW.folder_id AND kind='folder' AND trashed=0) THEN RAISE(ABORT,'Provider mount requires a folder') END;
END;
CREATE TRIGGER provider_mount_folder_kind BEFORE UPDATE OF kind ON resources WHEN NEW.kind!='folder' AND EXISTS(SELECT 1 FROM provider_mounts WHERE folder_id=OLD.id) BEGIN
 SELECT RAISE(ABORT,'Mounted resource must remain a folder');
END;
CREATE TABLE provider_connection_changes (
 connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE RESTRICT,
 revision INTEGER NOT NULL CHECK(revision>0),created_at INTEGER NOT NULL,
 PRIMARY KEY(connection_id,revision)
);
CREATE TABLE provider_connection_imports (
 legacy_key TEXT PRIMARY KEY CHECK(length(legacy_key) BETWEEN 1 AND 256),
 connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE RESTRICT,
 source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint)=64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
 created_at INTEGER NOT NULL
);
CREATE TRIGGER provider_connection_import_immutable BEFORE UPDATE ON provider_connection_imports BEGIN
 SELECT RAISE(ABORT,'Provider import receipt is immutable');
END;
CREATE TRIGGER provider_connection_import_delete BEFORE DELETE ON provider_connection_imports BEGIN
 SELECT RAISE(ABORT,'Provider import receipt is permanent');
END;
`;
/** Parent-table rebuilds run atomically with FK actions suspended, checked before commit, then enforced again. */
export const migrationForeignKeyRebuilds:readonly number[]=[23];
export const migrations = [core + epochTriggers, authInvalidation, authSettings, jobs, documents, workerSlots, uploads, pdfLayers, saveJournal, officeSessions, officeIngress, officeCleanup, officeRecovery, officePrepared, officePreparedBindings, officeSaveIntents, officeOpenings, officeHandoff, documentVisits, versionHistory, historyPreviews, historyRestores, legacyHistory, historyImports, historyCatalogue, providerConnections] as const;
export const applicationId = 0x5957494b; // YWIK; legacy Django uses no marker.
