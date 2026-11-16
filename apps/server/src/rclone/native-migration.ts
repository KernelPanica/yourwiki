import {createHash} from 'node:crypto';
import {transaction,type Database} from '../database.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {validateOfficeFile} from '../office/validation.ts';
import {ProviderError,type ProviderCheck} from '../providers/adapter.ts';
import {rcloneFingerprint,rcloneNativeFormat,type RcloneClient,type RcloneEntry} from './client.ts';

type Snapshot={document_id:string;connection_id:string;reference:string;fingerprint:string;revision:number;digest:string;size:number;format:string};
type Journal={path:string;original_reference:string;original_fingerprint:string;base_revision:number;digest:string;size:number;committed_at:number|null};
/** Caller owns native-migration lease. Concurrent source changes are fenced by fresh fingerprints and the final transaction. No delete/move of originals. */
export class NativeMigration {
 private db:Database;private store:BlobStore;
 constructor(db:Database,store:BlobStore){this.db=db;this.store=store;}
 private snapshot(id:string):Snapshot {
  const row=this.db.prepare(`SELECT b.document_id,b.connection_id,b.reference,b.fingerprint,d.local_revision AS revision,v.digest,v.size,d.format
   FROM provider_source_bindings b JOIN documents d ON d.id=b.document_id JOIN resources r ON r.id=d.id
   JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision JOIN provider_connections c ON c.id=b.connection_id
   WHERE d.id=? AND r.trashed=0 AND c.enabled=1 AND d.local_revision=d.provider_revision AND b.confirmed_revision=d.local_revision
   AND NOT EXISTS(SELECT 1 FROM provider_delivery_attempts a WHERE a.document_id=d.id AND a.state NOT IN ('confirmed','retired'))
   AND NOT EXISTS(SELECT 1 FROM provider_ingress_snapshots i WHERE i.document_id=d.id AND i.state IN ('pending','receiving','staged','conflict'))
   AND NOT EXISTS(SELECT 1 FROM office_sessions o WHERE o.document_id=d.id AND o.pending_operation_id IS NOT NULL)`).get(id) as Snapshot|undefined;
  if(!row)throw new ProviderError('PROVIDER_CONFLICT');return row;
 }
 async migrate(id:string,client:Pick<RcloneClient,'stat'|'upload'|'list'>,scope:ProviderCheck,knownEntries?:RcloneEntry[]){
  await scope.check();const existing=this.db.prepare('SELECT * FROM rclone_native_migrations WHERE document_id=?').get(id) as Journal|undefined;
  if(existing?.committed_at!==null&&existing?.committed_at!==undefined)return 'already';
  const start=this.snapshot(id),inventory=knownEntries??await client.list(scope),original=inventory.find(e=>e.ID===start.reference);
  if(!original||rcloneNativeFormat(original)!==start.format||rcloneFingerprint(original)!==start.fingerprint)throw new ProviderError('PROVIDER_CONFLICT');
  if(rcloneFingerprint(await client.stat(original.Path,scope))!==start.fingerprint)throw new ProviderError('PROVIDER_CONFLICT');
  if(!await this.store.verify({digest:start.digest,size:start.size},scope.signal))throw new ProviderError('PROVIDER_SOURCE_CHANGED');
  await validateOfficeFile(this.store,start,start.format,{signal:scope.signal,maxExpandedBytes:512*1024**2});
  const journal=transaction(this.db,()=>{
   const current=this.snapshot(id);if(JSON.stringify(current)!==JSON.stringify(start))throw new ProviderError('PROVIDER_CONFLICT');
   if(!existing){
    // UUID suffix avoids collisions with rclone's virtual .docx export of the native original.
    const parent=original.Path.includes('/')?original.Path.slice(0,original.Path.lastIndexOf('/')+1):'';
    const stem=original.Name.replace(/\.(docx|xlsx|pptx)$/i,'').slice(0,120).replace(/[\\/:\x00-\x1f\x7f]/g,'_')||'Document';
    const path=parent+stem+' [YourWiki '+id+'].'+start.format;
    if(inventory.some(e=>e.Path===path))throw new ProviderError('PROVIDER_CONFLICT');
    this.db.prepare('INSERT INTO rclone_native_migrations(document_id,connection_id,original_reference,original_fingerprint,base_revision,digest,size,path) VALUES(?,?,?,?,?,?,?,?)').run(id,start.connection_id,start.reference,start.fingerprint,start.revision,start.digest,start.size,path);
   }
   return this.db.prepare('SELECT * FROM rclone_native_migrations WHERE document_id=?').get(id) as Journal;
  });
  if(journal.original_reference!==start.reference||journal.original_fingerprint!==start.fingerprint||journal.base_revision!==start.revision||journal.digest!==start.digest||journal.size!==start.size)throw new ProviderError('PROVIDER_CONFLICT');
  const hash=createHash('md5');for await(const chunk of await this.store.read(start.digest)){await scope.check();hash.update(chunk);}const md5=hash.digest('hex');
  const matches=inventory.filter(e=>e.Path===journal.path);if(matches.length>1)throw new ProviderError('PROVIDER_CONFLICT');
  const target=matches[0]??await client.upload(await this.store.localFile(start.digest),journal.path,scope,true);
  if(target.ID===original.ID||target.IsDir||rcloneNativeFormat(target)||target.Size!==start.size||target.Hashes.md5?.toLowerCase()!==md5)throw new ProviderError('PROVIDER_CONFLICT');
  // Re-read both identities after upload. A changed Google original aborts the cutover.
  const after=await client.stat(original.Path,scope),verified=await client.stat(journal.path,scope);
  if(rcloneFingerprint(after)!==start.fingerprint||verified.ID!==target.ID||rcloneFingerprint(verified)!==rcloneFingerprint(target))throw new ProviderError('PROVIDER_CONFLICT');
  await scope.check();transaction(this.db,()=>{
   const current=this.snapshot(id);if(JSON.stringify(current)!==JSON.stringify(start))throw new ProviderError('PROVIDER_CONFLICT');
   if(this.db.prepare('SELECT 1 FROM provider_source_bindings WHERE connection_id=? AND reference=? AND document_id<>?').get(start.connection_id,target.ID,id))throw new ProviderError('PROVIDER_CONFLICT');
   this.db.prepare('UPDATE rclone_native_migrations SET destination_reference=?,destination_fingerprint=?,committed_at=? WHERE document_id=? AND committed_at IS NULL').run(target.ID,rcloneFingerprint(target),Date.now(),id);
   this.db.prepare('UPDATE provider_source_bindings SET reference=?,fingerprint=? WHERE document_id=?').run(target.ID,rcloneFingerprint(target),id);
   this.db.prepare('INSERT INTO rclone_drive_entries VALUES(?,?,?,?,?) ON CONFLICT(connection_id,reference) DO UPDATE SET path=excluded.path,metadata=excluded.metadata,seen_at=excluded.seen_at').run(start.connection_id,target.ID,journal.path,JSON.stringify(target),Date.now());
   this.db.prepare('UPDATE office_sessions SET superseded=1 WHERE document_id=?').run(id);
   this.db.prepare('DELETE FROM office_tokens WHERE office_session_id IN(SELECT id FROM office_sessions WHERE document_id=?)').run(id);
   this.db.prepare('UPDATE provider_sync_checks SET due_at=0 WHERE document_id=?').run(id);
  });if(!inventory.some(e=>e.ID===target.ID))inventory.push(target);return 'migrated';
 }
}
