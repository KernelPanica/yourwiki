import assert from 'node:assert/strict';
import type {Database} from '../../src/database.ts';
import {migrations} from '../../src/schema.ts';
/** Remove objects introduced at or after first, leaving a coherent historical fixture. */
export function removeGoogleTablesFrom(db:Database,first:number){
 const triggers:[number,string][]=[
  [70,'rclone_export_document_cleanup'],
  [65,'dashboard_local_no_trash'],[65,'dashboard_local_no_delete'],[65,'dashboard_local_document_no_delete'],[65,'dashboard_local_no_rename'],[65,'dashboard_local_binding'],
  [61,'provider_attempt_transition'],[53,'google_storage_export_version'],
  [48,'resource_purge_restore'],[48,'last_giga_update'],[48,'last_giga_delete'],[48,'user_trash_inactive'],
 ];
 for(const [version,trigger] of triggers)if(version>=first)db.exec('DROP TRIGGER '+trigger);
 if(first<=62)db.exec('DROP INDEX provider_ingress_activity_proof');
 if(first<=64)db.exec('DROP INDEX administration_audit_time');
 const tables:[number,string][]=[
  [70,'rclone_drive_folder_exports'],[69,'rclone_drive_entries'],[69,'rclone_drive_exports'],[69,'rclone_drive_mounts'],
  [68,'user_google_purge_cleanup'],[67,'service_plugins'],[66,'password_reset_links'],[65,'dashboard_local_file'],
  [64,'monitoring_logs'],[64,'monitoring_samples'],[63,'google_registration_attempts'],[62,'provider_google_watches'],
  [61,'provider_ingress_supersessions'],[60,'google_markdown_conflict_repairs'],[59,'markdown_saved_replies'],
  [57,'provider_google_folder_trash'],[56,'provider_backups'],
  [55,'resource_purge_cleanup'],[55,'resource_purge_blobs'],[54,'dashboard_document'],
  [53,'google_storage_exports'],[53,'google_storage_folder_exports'],
  [52,'google_storage_mounts'],[52,'google_root_reservations'],[52,'google_application_settings'],
  [51,'user_invite_groups'],[50,'document_presence'],[49,'content_ai_requests'],[49,'content_attachments'],[49,'content_reviews'],
  [48,'user_preferences'],[48,'invitations'],[48,'local_trash'],[48,'administration_audit'],[48,'folder_names'],[48,'resource_tombstones'],
 ];
 for(const [version,table] of tables)if(version>=first){
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM '+table).get() as {n:number}).n,0,'Future fixture table must be empty: '+table);
  db.exec('DROP TABLE '+table);
 }
 if(first<=58)db.exec('DROP TABLE provider_google_reconciliations');
 const singletons:[number,string,unknown][]=[
  [56,'provider_backup_settings',[{id:1,connection_id:null,prefix:'',revision:0}]],
  [49,'content_ai_settings',[{id:1,encrypted_config:'',revision:0}]],
  [48,'dashboard',[{id:1,revision:0,blocks:'[]'}]],
  [48,'administration_state',[{id:1,revision:0,name:'YourWiki',description:'',document_limit_bytes:4294967296,image_limit_bytes:5242880}]],
 ];
 for(const [version,table,expected] of singletons)if(version>=first){assert.deepEqual(db.prepare('SELECT * FROM '+table).all(),expected);db.exec('DROP TABLE '+table);}
 if(first<=68)db.exec('DROP TRIGGER provider_google_grant_import_update');
 if(first<=48){
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM users WHERE trashed_at IS NOT NULL OR purged_at IS NOT NULL OR can_invite!=0').get() as {n:number}).n,0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM groups WHERE trashed_at IS NOT NULL OR purged_at IS NOT NULL').get() as {n:number}).n,0);
  db.exec('ALTER TABLE users DROP COLUMN can_invite;ALTER TABLE users DROP COLUMN purged_at;ALTER TABLE users DROP COLUMN trashed_at;ALTER TABLE groups DROP COLUMN purged_at;ALTER TABLE groups DROP COLUMN trashed_at');
 }
 const googleTables:[number,string][]=[[47,'provider_google_operations'],[47,'provider_google_original_sessions'],[47,'provider_google_folders'],[47,'provider_google_trash_aliases'],[46,'provider_google_acl_scan'],[46,'provider_google_export_rules'],[46,'provider_google_grants'],[46,'provider_google_object_metadata'],[46,'provider_google_identity_states'],[46,'provider_google_identities'],[45,'provider_google_trash'],[44,'provider_google_imports'],[43,'provider_google_discovery_jobs']];
 for(const [version,table] of googleTables)if(version>=first)db.exec('DROP TABLE '+table);
 const restoreTrigger=(version:number,name:string)=>{const source=migrations[version-1],start=source.indexOf('CREATE TRIGGER '+name),end=source.indexOf('END;',start);assert.ok(start>=0&&end>start);db.exec(source.slice(start,end+4));};
 if(first<=61)restoreTrigger(first===61?60:28,'provider_attempt_transition');
 if(first<=68)restoreTrigger(37,'provider_google_grant_import_update');
 db.prepare('DELETE FROM schema_migrations WHERE version>=?').run(first);
}
