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
export const migrations = [core + epochTriggers, authInvalidation, authSettings, jobs, documents, workerSlots, uploads, pdfLayers] as const;
export const applicationId = 0x5957494b; // YWIK; legacy Django uses no marker.
