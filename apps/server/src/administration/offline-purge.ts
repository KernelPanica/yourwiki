import {lstat,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {openDatabase,transaction} from '../database.ts';
import {BlobStore} from '../storage/blobs.ts';
import {syncDirectory,workspacePaths} from '../release/workspace.ts';

const digestPattern=/^[a-f0-9]{64}$/;
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
const removable=['previews','preview_manifests','recovery_copies','pdf_layer_versions','document_visits','history_restores','history_previews','history_entries','content_reviews','content_attachments','document_presence','events','save_operations','provider_delivery_requests','provider_sync_checks','document_versions'];
/** Provider bindings include originals outside the main blob store, even for local
 * connections. Dedicated originals/receipt/namespace accounting must precede erasure. */
const retained=['provider_source_bindings','history_previews','office_sessions','office_ingress','office_prepared','office_openings','history_imports','provider_delivery_attempts','document_provider_origins','provider_sync_actions','provider_ingress_snapshots','provider_google_imports','provider_google_trash','provider_google_original_sessions','provider_google_operations','google_storage_exports','dashboard_document'];

/** Stop all services and hold the runtime's exclusive release.lock before calling.
 * Only queued tombstones are considered. In particular this is never a global orphan sweep.
 * Unsupported receipts block that document without modifying any of its content.
 */
export async function purgeOfflineWorkspace(workspace:string){
 const paths=workspacePaths(workspace);
 for(const path of [workspace,paths.databasePath,paths.storagePath,join(paths.storagePath,'blobs')]){const info=await lstat(path);if(info.isSymbolicLink())throw new Error('UNSAFE_WORKSPACE_ENTRY');}
 const db=openDatabase(paths.databasePath),store=await BlobStore.open(paths.storagePath);
 const cleaned:string[]=[];
 let completed=0,blocked=0,deletedBlobs=0,preservedBlobs=0;
 const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(r=>r.name));
 const columns=(table:string)=>(db.prepare(`PRAGMA table_info(${quote(table)})`).all() as {name:string;type:string}[]);
 const collectRow=(row:Record<string,unknown>,into:Set<string>)=>{for(const [key,value] of Object.entries(row))if(/digest$/.test(key)&&typeof value==='string'&&digestPattern.test(value))into.add(value);};
 const manifestDigests=async(digest:string,into:Set<string>)=>{
  const path=await store.localFile(digest),info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024**2)throw new Error('INVALID_PREVIEW_MANIFEST');
  const value=JSON.parse(await readFile(path,'utf8'));
  if(!Array.isArray(value.artifacts))throw new Error('INVALID_PREVIEW_MANIFEST');
  for(const artifact of value.artifacts){if(!digestPattern.test(artifact.digest)||!Number.isSafeInteger(artifact.size)||artifact.size<0)throw new Error('INVALID_PREVIEW_MANIFEST');into.add(artifact.digest);}
 };
 try{
  // An accidental invocation while a leased worker is active fails closed as well.
  if(db.prepare('SELECT 1 FROM worker_slots WHERE lease_until>?').get(Date.now())||db.prepare("SELECT 1 FROM jobs WHERE state='running' AND lease_until>?").get(Date.now()))throw new Error('PURGE_WORKERS_ACTIVE');
  const pending=db.prepare("SELECT resource_id FROM resource_purge_cleanup WHERE state!='complete' ORDER BY resource_id").all() as {resource_id:string}[];
  for(const {resource_id:id} of pending){
   if(!db.prepare('SELECT 1 FROM resource_tombstones WHERE resource_id=?').get(id))throw new Error('PURGE_TOMBSTONE_MISSING');
   const unsupported=retained.find(table=>tables.has(table)&&db.prepare(`SELECT 1 FROM ${quote(table)} WHERE document_id=? LIMIT 1`).get(id));
   if(unsupported){db.prepare("UPDATE resource_purge_cleanup SET state='blocked',error_code='PURGE_RETAINED_RECEIPTS' WHERE resource_id=?").run(id);blocked++;continue;}
   const candidates=new Set<string>();
   const condition=(table:string)=>table==='recovery_copies'?'document_id=? OR intended_document_id=?':'document_id=?';
   const argumentsFor=(table:string)=>table==='recovery_copies'?[id,id]:[id];
   for(const table of removable)if(tables.has(table))for(const row of db.prepare(`SELECT * FROM ${quote(table)} WHERE ${condition(table)}`).iterate(...argumentsFor(table)) as Iterable<Record<string,unknown>>)collectRow(row,candidates);
   // Main-store preview artifacts are reachable through manifest JSON, not SQL.
   for(const row of db.prepare('SELECT manifest_digest FROM preview_manifests WHERE document_id=?').iterate(id) as Iterable<{manifest_digest:string}>)await manifestDigests(row.manifest_digest,candidates);
   transaction(db,()=>{
    for(const digest of candidates)db.prepare('INSERT OR IGNORE INTO resource_purge_blobs(digest) VALUES(?)').run(digest);
    // History preview generation/legacy metadata cascade from history_entries.
    for(const table of removable)if(tables.has(table))db.prepare(`DELETE FROM ${quote(table)} WHERE ${condition(table)}`).run(...argumentsFor(table));
    db.prepare("UPDATE documents SET title='Deleted document',local_revision=0,published_revision=NULL,preview_job_id=NULL WHERE id=?").run(id);
    db.prepare("UPDATE folder_names SET name='Deleted folder' WHERE resource_id=?").run(id);
    db.prepare("UPDATE resource_purge_cleanup SET state='pending',error_code=NULL WHERE resource_id=?").run(id);
   });cleaned.push(id);completed++;
  }
  // Protect every digest-bearing SQL column, including in-flight/pending references
  // and retained receipts, rather than just the accepted backup reference subset.
  const protectedDigests=new Set<string>();
  for(const table of tables){if(table==='resource_purge_blobs')continue;const names=columns(table).filter(c=>/digest$/.test(c.name)).map(c=>c.name);if(!names.length)continue;
   for(const row of db.prepare(`SELECT ${names.map(quote).join(',')} FROM ${quote(table)}`).iterate() as Iterable<Record<string,unknown>>)collectRow(row,protectedDigests);
  }
  for(const row of db.prepare('SELECT manifest_digest FROM preview_manifests').iterate() as Iterable<{manifest_digest:string}>)await manifestDigests(row.manifest_digest,protectedDigests);
  for(const {digest} of db.prepare('SELECT digest FROM resource_purge_blobs').all() as {digest:string}[]){
   if(protectedDigests.has(digest)){preservedBlobs++;continue;}
   const path=join(paths.storagePath,'blobs',digest.slice(0,2),digest.slice(2));
   try{const prefix=await lstat(join(paths.storagePath,'blobs',digest.slice(0,2)));if(!prefix.isDirectory()||prefix.isSymbolicLink())throw new Error('UNSAFE_STORAGE_ENTRY');const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw new Error('UNSAFE_STORAGE_ENTRY');await unlink(path);await syncDirectory(join(paths.storagePath,'blobs',digest.slice(0,2)));deletedBlobs++;}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   db.prepare('DELETE FROM resource_purge_blobs WHERE digest=?').run(digest);
  }
  for(const id of cleaned)db.prepare("UPDATE resource_purge_cleanup SET state='complete',completed_at=? WHERE resource_id=?").run(Date.now(),id);
  if((db.pragma('foreign_key_check') as unknown[]).length)throw new Error('PURGE_REFERENCE_INTEGRITY');
  return {completed,blocked,deletedBlobs,preservedBlobs};
 }finally{db.close();}
}
