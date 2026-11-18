import {Readable} from 'node:stream';
import {createReadStream,lstatSync,unlinkSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,unlink,open,mkdir,rename,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import Sqlite from 'better-sqlite3';
import {referencedSource,type RcloneReference} from './rclone-reference.ts';
import {BlobStore,type ByteRange,type BlobRef} from './blobs.ts';
import {RcloneClient,rcloneFingerprint,rcloneNativeFormat,rclonePath,type RcloneEntry} from '../rclone/client.ts';
export type OriginalSource=BlobRef&{path:string;md5:string;commitEviction?:(remove:()=>number)=>number;canEvict?:()=>boolean;prepare?:()=>Promise<void>;check:()=>Promise<void>};
export type OriginalResolver=(digest:string)=>Promise<OriginalSource|null>;
function digest(value:string){if(!/^[a-f0-9]{64}$/.test(value))throw Error('Invalid blob digest');}
export const protectedPayload=(database:Sqlite.Database,value:string)=>Boolean(database.prepare("SELECT 1 FROM recovery_copies WHERE digest=? UNION ALL SELECT 1 FROM content_attachments WHERE digest=? UNION ALL SELECT 1 FROM pdf_layer_versions WHERE digest=? UNION ALL SELECT 1 FROM history_entries WHERE digest=? UNION ALL SELECT 1 FROM save_operations WHERE digest=? AND state='staged' UNION ALL SELECT 1 FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision LEFT JOIN provider_source_bindings b ON b.document_id=d.id LEFT JOIN provider_connections c ON c.id=b.connection_id WHERE v.digest=? AND (b.document_id IS NULL OR b.confirmed_revision<>v.revision OR (CASE WHEN json_valid(b.fingerprint) THEN json_extract(b.fingerprint,'$[0]') ELSE '' END)<>'rclone-drive-v1' OR c.enabled=0 AND d.format NOT IN ('docx','xlsx','pptx','doc','xls','ppt','odt','ods','odp') AND NOT EXISTS(SELECT 1 FROM rclone_external_payloads x WHERE x.digest=v.digest AND x.size=v.size)) LIMIT 1").get(value,value,value,value,value,value));

const currentSources=`SELECT v.digest,v.size,b.connection_id,b.reference,b.fingerprint,e.path,e.metadata,
 m.binary_path,m.config_path,m.mount_path,m.staging_path
 FROM documents d JOIN provider_source_bindings b ON b.document_id=d.id
 JOIN document_versions v ON v.document_id=d.id AND v.revision=b.confirmed_revision
 JOIN provider_connections c ON c.id=b.connection_id AND c.enabled=1 AND c.provider='google'
 JOIN rclone_drive_entries e ON e.connection_id=b.connection_id AND e.reference=b.reference
 JOIN rclone_drive_mounts m ON m.connection_id=b.connection_id AND (CASE WHEN json_valid(b.fingerprint) THEN json_extract(b.fingerprint,'$[0]') ELSE '' END)='rclone-drive-v1'`;
export type SourceRow=BlobRef&{connection_id:string;reference:string;fingerprint:string;path:string;metadata:string;binary_path:string;config_path:string;mount_path:string;staging_path:string};
/** Only confirmed current binary originals can replace immutable local payload.
 * Native exports and unconfirmed edits stay in the local outbox until cutover. */
export function originalResolver(databasePath:string,options:{checkRemote?:(row:SourceRow,client:RcloneClient)=>Promise<RcloneEntry>}={}):OriginalResolver{
 return async value=>{
  digest(value);const db=new Sqlite(databasePath,{readonly:true,fileMustExist:true});let row:SourceRow|undefined;const directories=new Map<string,string>();
  try{
   db.pragma('busy_timeout=5000');row=db.prepare(currentSources+' WHERE v.digest=? ORDER BY b.created_at DESC LIMIT 1').get(value) as SourceRow|undefined;
   if(row?.path.includes('/')){const parent=row.path.slice(0,row.path.lastIndexOf('/')),folder=db.prepare('SELECT reference,metadata FROM rclone_drive_entries WHERE connection_id=? AND path=?').get(row.connection_id,parent) as {reference:string;metadata:string}|undefined;
    if(folder){const metadata=JSON.parse(folder.metadata);if(metadata.IsDir===true&&metadata.ID===folder.reference&&/^[-\w]{1,256}$/.test(folder.reference))directories.set(parent,folder.reference);}
   }
  }finally{db.close();}
  if(!row){const snapshot=new Sqlite(databasePath,{readonly:true,fileMustExist:true});let external:RcloneReference|undefined;
   try{external=snapshot.prepare(`SELECT x.*,m.binary_path,m.config_path,m.mount_path,m.staging_path FROM rclone_external_payloads x JOIN provider_connections c ON c.id=x.access_connection_id AND c.enabled=1 AND c.provider='google' JOIN rclone_drive_mounts m ON m.connection_id=c.id WHERE x.digest=?`).get(value) as RcloneReference|undefined;}finally{snapshot.close();}
   return external?referencedSource(databasePath,join(dirname(databasePath),'storage'),external):null;
  }
  const entry=JSON.parse(row.metadata);if(rcloneNativeFormat(entry))return null;
  if(entry.ID!==row.reference||rcloneFingerprint(entry)!==row.fingerprint||entry.Size!==row.size)throw Error('PROVIDER_SOURCE_CHANGED');
  rclonePath(row.path);
  const client=new RcloneClient({binary:row.binary_path,config:row.config_path,mount:row.mount_path,staging:row.staging_path},directories);
  const check=async()=>{
   const current=options.checkRemote?await options.checkRemote(row!,client):await client.stat(row!.path,{check(){}});
   if(current.ID!==row!.reference||rcloneFingerprint(current)!==row!.fingerprint||current.Size!==row!.size)throw Error('PROVIDER_SOURCE_CHANGED');
   const snapshot=new Sqlite(databasePath,{readonly:true,fileMustExist:true});
   try{if(!snapshot.prepare(currentSources+' WHERE v.digest=? AND b.reference=? AND b.fingerprint=? AND e.path=? LIMIT 1').get(value,row!.reference,row!.fingerprint,row!.path))throw Error('PROVIDER_SOURCE_CHANGED');}finally{snapshot.close();}
  };
  const canEvict=()=>{
   const snapshot=new Sqlite(databasePath,{readonly:true,fileMustExist:true});
   try{return !protectedPayload(snapshot,value)&&(snapshot.prepare('SELECT history_enabled FROM app_state WHERE id=1').get() as {history_enabled:number}).history_enabled===0;}finally{snapshot.close();}
  };
  const commitEviction=(remove:()=>number)=>{
   const database=new Sqlite(databasePath,{fileMustExist:true});database.pragma('busy_timeout=5000');database.pragma('synchronous=FULL');
   try{
    database.prepare('INSERT INTO rclone_remote_payloads(digest,size,connection_id,reference,fingerprint,evicted_at) VALUES(?,?,?,?,?,?) ON CONFLICT(digest) DO UPDATE SET connection_id=excluded.connection_id,reference=excluded.reference,fingerprint=excluded.fingerprint,evicted_at=excluded.evicted_at').run(value,row!.size,row!.connection_id,row!.reference,row!.fingerprint,Date.now());
    return database.transaction(()=>{
     if(protectedPayload(database,value)||!database.prepare(currentSources+' WHERE v.digest=? AND b.reference=? AND b.fingerprint=? AND e.path=? LIMIT 1').get(value,row!.reference,row!.fingerprint,row!.path))return 0;
     return remove();
    }).immediate();
   }finally{database.close();}
  };
  return {commitEviction,canEvict,digest:value,size:row.size,md5:entry.Hashes.md5.toLowerCase(),path:join(row.mount_path,row.path),prepare:()=>client.refresh(row!.path,{check(){}}),check};
 };
}
/** Drive is authoritative for confirmed current files; local CAS is an outbox and derived cache.
 * No copy is made on read. An unavailable Drive must never silently serve stale bytes. */
export class RcloneOriginalStore extends BlobStore{
 readonly backend='rclone' as const;
 private readonly local:BlobStore;private readonly resolve:OriginalResolver;private readonly storageRoot:string;
 constructor(root:string,local:BlobStore,resolve:OriginalResolver){super(root);this.local=local;this.resolve=resolve;this.storageRoot=root;}
 private async source(value:string){digest(value);const source=await this.resolve(value);if(!source)return null;await source.check();await source.prepare?.();const info=await lstat(source.path);if(!info.isFile()||info.isSymbolicLink()||info.size!==source.size)throw Error('PROVIDER_SOURCE_CHANGED');return source;}
 override async stat(value:string):Promise<BlobRef>{const source=await this.source(value);return source?{digest:value,size:source.size}:this.local.stat(value);}
 override async localFile(value:string){
  const source=await this.source(value);if(!source)return this.local.localFile(value);
  // Seekable consumers receive a verified private processing snapshot; a mutable
  // FUSE path must never be passed to a converter under an immutable digest.
  const directory=join(this.storageRoot,'read-cache');await mkdir(directory,{recursive:true,mode:0o700});
  const path=join(directory,value),temporary=join(directory,randomUUID()+'.part');
  const file=await open(temporary,'wx',0o600);
  try{
   const hash=createHash('sha256');let size=0;
   for await(const part of createReadStream(source.path,{signal:AbortSignal.timeout(180000)})){size+=part.length;if(size>source.size)throw Error('PROVIDER_SOURCE_CHANGED');hash.update(part);await file.writeFile(part);}
   if(size!==source.size||hash.digest('hex')!==value)throw Error('PROVIDER_SOURCE_CHANGED');
   await source.check();await file.sync();await file.close();await rename(temporary,path);return path;
  }catch(error){await file.close().catch(()=>{});throw error;}finally{await rm(temporary,{force:true});}
 }
 override async read(value:string,range?:ByteRange){
  const source=await this.source(value);if(!source)return this.local.read(value,range);
  if(range&&(!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end<range.start||range.end>=source.size))throw Error('Invalid byte range');
  return Readable.from((async function*(){
   const hash=createHash('sha256');let size=0;const stream=createReadStream(source.path,{...range,signal:AbortSignal.timeout(180000)});
   try{for await(const part of stream){size+=part.length;if(size>(range?range.end-range.start+1:source.size))throw Error('PROVIDER_SOURCE_CHANGED');if(!range)hash.update(part);yield part;}
    if(size!==(range?range.end-range.start+1:source.size)||!range&&hash.digest('hex')!==value)throw Error('PROVIDER_SOURCE_CHANGED');
    await source.check();
   }finally{stream.destroy();}
  })());
 }
 /** Remove a confirmed duplicate, never a pending edit or a cloud object.
  * Both hashes are streamed from the already-local file, so cleanup downloads no payload. */
 async evictConfirmed(value:string):Promise<number>{
  digest(value);const source=await this.resolve(value);if(!source||source.canEvict?.()===false)return 0;
  const path=join(this.storageRoot,'blobs',value.slice(0,2),value.slice(2));
  let file;try{file=await open(path,'r');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;throw error;}
  try{
   const before=await file.stat();if(!before.isFile()||before.size!==source.size)throw Error('CORRUPT_LOCAL_COPY');
   const sha=createHash('sha256'),md5=createHash('md5');for await(const chunk of file.createReadStream({autoClose:false})){sha.update(chunk);md5.update(chunk);}
   if(sha.digest('hex')!==value||md5.digest('hex')!==source.md5)throw Error('CORRUPT_LOCAL_COPY');
   await source.check();
   if(source.canEvict?.()===false)return 0;
   const remove=()=>{const after=lstatSync(path);if(after.isSymbolicLink()||after.ino!==before.ino||after.dev!==before.dev||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('LOCAL_COPY_CHANGED');unlinkSync(path);return before.size;};
   const removed=source.commitEviction?source.commitEviction(remove):remove();
   if(removed){const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}}return removed;
  }finally{await file.close();}
 }
}
/** Snapshot metadata only. Per-file deletion still revalidates remote and local identity. */
export function originalDigests(databasePath:string):string[]{
 const db=new Sqlite(databasePath,{readonly:true,fileMustExist:true});try{return (db.prepare('SELECT DISTINCT digest FROM ('+currentSources+')').all() as {digest:string}[]).map(r=>r.digest);}finally{db.close();}
}

export function originalMetadataReferences(db:Sqlite.Database):Map<string,number>{
 const result=new Map<string,number>();
 for(const row of db.prepare('SELECT digest,size FROM rclone_external_payloads').iterate() as Iterable<BlobRef>)result.set(row.digest,row.size);
 for(const row of db.prepare(currentSources).iterate() as Iterable<SourceRow>){
  const entry=JSON.parse(row.metadata);
  if(rcloneNativeFormat(entry))continue;
  if(entry.ID!==row.reference||rcloneFingerprint(entry)!==row.fingerprint||entry.Size!==row.size)throw Error('INVALID_REMOTE_STORAGE_REFERENCE');
  result.set(row.digest,row.size);
 }
 return result;
}

/** Bulk maintenance uses a fresh scoped catalogue instead of thousands of CLI
 * processes. Every deletion still validates identity, hashes and live DB refs.
 * Reads from the application continue to use individual fresh stat checks. */
export function catalogueVerifier(){
 type Snapshot={at:number;entries:Map<string,RcloneEntry>;pending?:Promise<void>};
 const snapshots=new Map<string,Snapshot>();
 return async(row:SourceRow,client:RcloneClient):Promise<RcloneEntry>=>{
  const key=client.runtime.config;let snapshot=snapshots.get(key);
  if(!snapshot){snapshot={at:0,entries:new Map()};snapshots.set(key,snapshot);}
  const current=snapshot;
  if(Date.now()-current.at>10000){
   current.pending??=client.list({check(){}}).then(rows=>{current.entries=new Map(rows.map(e=>[e.ID,e]));current.at=Date.now();}).finally(()=>{current.pending=undefined;});
   await current.pending;
  }
  client.check();const entry=current.entries.get(row.reference);
  if(!entry||entry.Path!==row.path)throw Error('PROVIDER_SOURCE_CHANGED');return entry;
 };
}
