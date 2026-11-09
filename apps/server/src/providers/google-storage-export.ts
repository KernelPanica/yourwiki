import type {Database} from '../database.ts';
/** Join only a new local file's commit. Existing data and remote imports are untouched. */
export function queueGoogleStorageExport(db:Database,id:string,actor:string){
 let parent=(db.prepare('SELECT parent_id FROM resources WHERE id=?').get(id) as {parent_id:string|null}).parent_id;
 const seen=new Set<string>();
 for(let depth=0;depth<34;depth++){
  const mount=db.prepare('SELECT m.connection_id,c.provider,c.enabled,s.connection_id AS storage FROM provider_mounts m JOIN provider_connections c ON c.id=m.connection_id LEFT JOIN google_storage_mounts s ON s.connection_id=c.id WHERE m.folder_id IS ?').get(parent) as {connection_id:string;provider:string;enabled:number;storage:string|null}|undefined;
  if(mount){if(mount.provider==='google'&&mount.storage)db.prepare('INSERT INTO google_storage_exports(document_id,connection_id,actor_id,revision) VALUES(?,?,?,1)').run(id,mount.connection_id,actor);return;}
  if(parent===null||seen.has(parent))return;seen.add(parent);parent=(db.prepare('SELECT parent_id FROM resources WHERE id=?').get(parent) as {parent_id:string|null}).parent_id;
 }
}
