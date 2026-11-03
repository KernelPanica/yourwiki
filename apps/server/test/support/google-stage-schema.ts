import type {Database} from '../../src/database.ts';
/** Owned empty future tables only: construct an old-version fixture before exercising a real upgrade. */
export function removeGoogleTablesFrom(db:Database,first:number){
 const tables:[number,string][]=[[47,'provider_google_operations'],[47,'provider_google_original_sessions'],[47,'provider_google_folders'],[47,'provider_google_trash_aliases'],[46,'provider_google_acl_scan'],[46,'provider_google_export_rules'],[46,'provider_google_grants'],[46,'provider_google_object_metadata'],[46,'provider_google_identity_states'],[46,'provider_google_identities'],[45,'provider_google_trash'],[44,'provider_google_imports'],[43,'provider_google_discovery_jobs']];
 for(const [version,table] of tables)if(version>=first)db.exec('DROP TABLE '+table);
 db.prepare('DELETE FROM schema_migrations WHERE version>=?').run(first);
}
