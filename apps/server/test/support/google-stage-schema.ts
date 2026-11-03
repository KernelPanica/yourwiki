import assert from 'node:assert/strict';
import type {Database} from '../../src/database.ts';
/** Owned future schema only: validate its neutral state before constructing a real old-version fixture. */
export function removeGoogleTablesFrom(db:Database,first:number){
 // Current fixture creation installs later migrations. Undo their neutral additions
 // too, otherwise deleting their receipts would replay ALTER TABLE against current columns.
 db.exec('DROP TRIGGER resource_purge_restore');
 for(const table of ['resource_tombstones','content_ai_requests','content_attachments','content_reviews','user_preferences','invitations','local_trash','administration_audit','folder_names']){
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM '+table).get() as {n:number}).n,0,'Future fixture table must be empty: '+table);
  db.exec('DROP TABLE '+table);
 }
 assert.deepEqual(db.prepare('SELECT * FROM content_ai_settings').all(),[{id:1,encrypted_config:'',revision:0}]);
 assert.deepEqual(db.prepare('SELECT * FROM dashboard').all(),[{id:1,revision:0,blocks:'[]'}]);
 assert.deepEqual(db.prepare('SELECT * FROM administration_state').all(),[{id:1,revision:0,name:'YourWiki',description:'',document_limit_bytes:4294967296,image_limit_bytes:5242880}]);
 db.exec('DROP TABLE content_ai_settings;DROP TABLE dashboard;DROP TABLE administration_state;DROP TRIGGER last_giga_update;DROP TRIGGER last_giga_delete;DROP TRIGGER user_trash_inactive');
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM users WHERE trashed_at IS NOT NULL OR purged_at IS NOT NULL OR can_invite!=0').get() as {n:number}).n,0);
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM groups WHERE trashed_at IS NOT NULL OR purged_at IS NOT NULL').get() as {n:number}).n,0);
 db.exec('ALTER TABLE users DROP COLUMN can_invite;ALTER TABLE users DROP COLUMN purged_at;ALTER TABLE users DROP COLUMN trashed_at;ALTER TABLE groups DROP COLUMN purged_at;ALTER TABLE groups DROP COLUMN trashed_at');
 const tables:[number,string][]=[[47,'provider_google_operations'],[47,'provider_google_original_sessions'],[47,'provider_google_folders'],[47,'provider_google_trash_aliases'],[46,'provider_google_acl_scan'],[46,'provider_google_export_rules'],[46,'provider_google_grants'],[46,'provider_google_object_metadata'],[46,'provider_google_identity_states'],[46,'provider_google_identities'],[45,'provider_google_trash'],[44,'provider_google_imports'],[43,'provider_google_discovery_jobs']];
 for(const [version,table] of tables)if(version>=first)db.exec('DROP TABLE '+table);
 db.prepare('DELETE FROM schema_migrations WHERE version>=?').run(first);
}
