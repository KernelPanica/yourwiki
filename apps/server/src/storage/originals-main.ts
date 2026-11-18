import {RcloneClient} from '../rclone/client.ts';
import {createReadStream,lstatSync,unlinkSync} from 'node:fs';
import {lstat,open,mkdir,rename,writeFile} from 'node:fs/promises';
import {join,dirname,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {openDatabase,transaction,type Database} from '../database.ts';
import {BlobStore} from './blobs.ts';
import {RcloneOriginalStore,originalResolver,originalDigests,catalogueVerifier,protectedPayload,type OriginalSource} from './rclone-originals.ts';
import {referencedSource,type RcloneReference} from './rclone-reference.ts';
/** Only Office history and legacy copies on disabled connections are discardable.
 * Active/current originals, unbound files, attachments and recovery copies remain protected. */
export function retiredOfficeDigests(db:Database,onlyDigest?:string):string[]{
 return (db.prepare(`SELECT DISTINCT v.digest FROM document_versions v JOIN documents d ON d.id=v.document_id
 JOIN provider_source_bindings b ON b.document_id=d.id JOIN provider_connections c ON c.id=b.connection_id
 WHERE d.format IN ('docx','xlsx','pptx','doc','xls','ppt','odt','ods','odp')
 AND v.revision<=b.confirmed_revision
 AND (v.revision<d.local_revision OR c.enabled=0)
 AND NOT EXISTS(SELECT 1 FROM document_versions cv JOIN documents cd ON cd.id=cv.document_id
 LEFT JOIN provider_source_bindings cb ON cb.document_id=cd.id LEFT JOIN provider_connections cc ON cc.id=cb.connection_id
 WHERE cv.digest=v.digest AND cv.revision=cd.local_revision AND (cc.enabled=1 OR cb.document_id IS NULL OR cv.revision>cb.confirmed_revision OR cd.format NOT IN ('docx','xlsx','pptx','doc','xls','ppt','odt','ods','odp')))
 AND NOT EXISTS(SELECT 1 FROM save_operations s WHERE s.digest=v.digest AND s.state='staged')
 AND NOT EXISTS(SELECT 1 FROM office_sessions s WHERE s.base_digest=v.digest AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER))
 AND NOT EXISTS(SELECT 1 FROM recovery_copies r WHERE r.digest=v.digest)
 AND NOT EXISTS(SELECT 1 FROM content_attachments a WHERE a.digest=v.digest)
 AND NOT EXISTS(SELECT 1 FROM pdf_layer_versions p WHERE p.digest=v.digest)
 ${onlyDigest?' AND v.digest=?':''}`).all(...(onlyDigest?[onlyDigest]:[])) as {digest:string}[]).map(r=>r.digest);
}
export async function discardOfficeCopy(db:Database,root:string,value:string,available?:(digest:string)=>Promise<boolean>){
 if(!/^[a-f0-9]{64}$/.test(value))throw Error('Invalid blob digest');
 if(!available)throw Error('REMOTE_AVAILABILITY_REQUIRED');if(!await available(value))return 0;
 const path=join(root,'blobs',value.slice(0,2),value.slice(2));let info;
 try{info=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;throw error;}
 if(!info.isFile()||info.isSymbolicLink())throw Error('INVALID_LOCAL_COPY');
 const sha=createHash('sha256');for await(const part of createReadStream(path))sha.update(part);if(sha.digest('hex')!==value)throw Error('CORRUPT_LOCAL_COPY');
 if(!await available(value))return 0;
 const approved=transaction(db,()=>{
  if(!retiredOfficeDigests(db,value).includes(value))return false;
  db.prepare("INSERT INTO rclone_discarded_payloads VALUES(?,?,'local-office-history',?) ON CONFLICT(digest) DO NOTHING").run(value,info.size,Date.now());return true;
 });
 if(!approved)return 0;
 return transaction(db,()=>{
  if(!retiredOfficeDigests(db,value).includes(value))return 0;
  const after=lstatSync(path);if(after.isSymbolicLink()||after.ino!==info.ino||after.dev!==info.dev||after.mtimeMs!==info.mtimeMs||after.size!==info.size)throw Error('LOCAL_COPY_CHANGED');
  // Durable receipt precedes local unlink. Cloud objects and ACL are untouched.
  unlinkSync(path);return info.size;
 });
}

/** Read-only preflight across the active account, including old originals outside
 * the currently mounted folder. Unavailable old originals are never deleted. */
export function legacyOriginalAvailability(db:Database){
 let checkedAt=0,ids=new Set<string>(),pending:Promise<void>|undefined;
 return async(value:string)=>{
  if(Date.now()-checkedAt>30000){
   pending??=(async()=>{
    const rows=db.prepare("SELECT m.* FROM rclone_drive_mounts m JOIN provider_connections c ON c.id=m.connection_id WHERE c.enabled=1 AND c.provider='google'").all() as {binary_path:string;config_path:string;mount_path:string;staging_path:string}[];
    const found=new Set<string>();
    for(const row of rows){
     const client=new RcloneClient({binary:row.binary_path,config:row.config_path,mount:row.mount_path,staging:row.staging_path});
     const objects=JSON.parse(await client.command(['backend','query','drive:','trashed = false'],{check(){}},180000));
     if(!Array.isArray(objects)||objects.length>100000)throw Error('INVALID_REMOTE_CATALOGUE');
     for(const object of objects)if(typeof object.id==='string'&&typeof object.mimeType==='string'&&object.mimeType!=='application/vnd.google-apps.folder')found.add(object.id);
    }
    if(!rows.length)throw Error('REMOTE_AVAILABILITY_REQUIRED');ids=found;checkedAt=Date.now();
   })().finally(()=>{pending=undefined;});
   await pending;
  }
  return (db.prepare('SELECT DISTINCT b.reference FROM document_versions v JOIN provider_source_bindings b ON b.document_id=v.document_id WHERE v.digest=? AND v.revision<=b.confirmed_revision').all(value) as {reference:string}[]).some(row=>ids.has(row.reference));
 };
}

/** Verify the exact original before retiring a legacy non-Office replica. The
 * receipt is committed durably before local unlink; pending/shared work is pinned. */
export async function retireExternalCopy(db:Database,root:string,ref:RcloneReference,resolve=(r:RcloneReference)=>referencedSource(join(dirname(root),'database.sqlite3'),root,r)){
 const value=ref.digest;if(!/^[a-f0-9]{64}$/.test(value))throw Error('INVALID_STORAGE_REFERENCE');
 const eligible=()=>Boolean(db.prepare(`SELECT 1 FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision JOIN provider_source_bindings b ON b.document_id=d.id AND b.confirmed_revision=v.revision JOIN provider_connections c ON c.id=b.connection_id AND c.enabled=0 WHERE v.digest=? AND v.size=? AND b.reference=? AND b.connection_id=? AND d.format NOT IN ('docx','xlsx','pptx','doc','xls','ppt','odt','ods','odp')`).get(value,ref.size,ref.reference,ref.source_connection_id));
 if(!eligible())return 0;
 const path=join(root,'blobs',value.slice(0,2),value.slice(2));let before;
 try{before=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;throw error;}
 if(!before.isFile()||before.isSymbolicLink()||before.size!==ref.size)throw Error('INVALID_LOCAL_COPY');
 const source:OriginalSource=await resolve(ref);await source.check();
 const hash=createHash('sha256');let size=0;for await(const part of createReadStream(source.path)){hash.update(part);size+=part.length;}
 if(size!==ref.size||hash.digest('hex')!==value)throw Error('PROVIDER_SOURCE_CHANGED');
 await source.check();db.pragma('synchronous=FULL');
 transaction(db,()=>{if(!eligible())throw Error('PROVIDER_SOURCE_CHANGED');db.prepare(`INSERT INTO rclone_external_payloads VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(digest) DO UPDATE SET size=excluded.size,md5=excluded.md5,source_connection_id=excluded.source_connection_id,reference=excluded.reference,access_connection_id=excluded.access_connection_id,parent_id=excluded.parent_id,verified_at=excluded.verified_at`).run(value,ref.size,ref.md5,ref.source_connection_id,ref.reference,ref.access_connection_id,ref.parent_id,Date.now());});
 return transaction(db,()=>{
  if(!eligible()||protectedPayload(db,value)||(db.prepare('SELECT history_enabled FROM app_state WHERE id=1').get() as {history_enabled:number}).history_enabled)return 0;
  const after=lstatSync(path);if(after.isSymbolicLink()||after.ino!==before.ino||after.dev!==before.dev||after.mtimeMs!==before.mtimeMs||after.size!==before.size)throw Error('LOCAL_COPY_CHANGED');
  unlinkSync(path);return before.size;
 });
}
export async function legacyReferences(db:Database):Promise<RcloneReference[]>{
 const runtimes=db.prepare("SELECT m.* FROM rclone_drive_mounts m JOIN provider_connections c ON c.id=m.connection_id WHERE c.enabled=1 AND c.provider='google'").all() as any[];
 const candidates=db.prepare(`SELECT DISTINCT v.digest,v.size,b.connection_id source_connection_id,b.reference FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision JOIN provider_source_bindings b ON b.document_id=d.id AND b.confirmed_revision=v.revision JOIN provider_connections c ON c.id=b.connection_id AND c.enabled=0 WHERE d.format NOT IN ('docx','xlsx','pptx','doc','xls','ppt','odt','ods','odp')`).all() as any[];
 const references=new Map<string,RcloneReference>();
 for(const runtime of runtimes){
  const client=new RcloneClient({binary:runtime.binary_path,config:runtime.config_path,mount:runtime.mount_path,staging:runtime.staging_path});
  const rows=JSON.parse(await client.command(['backend','query','drive:','trashed = false'],{check(){}},180000));if(!Array.isArray(rows)||rows.length>100000)throw Error('INVALID_REMOTE_CATALOGUE');
  const objects=new Map(rows.map((row:any)=>[row.id,row]));
  for(const candidate of candidates){const object:any=objects.get(candidate.reference);if(object&&String(object.size)===String(candidate.size)&&/^[a-f0-9]{32}$/i.test(object.md5Checksum)&&!object.mimeType?.startsWith('application/vnd.google-apps.'))references.set(candidate.digest,{...candidate,md5:object.md5Checksum.toLowerCase(),access_connection_id:runtime.connection_id,parent_id:object.parents?.[0]??null,binary_path:runtime.binary_path,config_path:runtime.config_path,mount_path:runtime.mount_path,staging_path:runtime.staging_path});}
 }
 return [...references.values()];
}

export async function enableOriginals(root:string){
 const marker=join(root,'rclone-originals.json'),temporary=marker+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,JSON.stringify({version:1,kind:'rclone-originals'})+'\n',{mode:0o600,flag:'wx'});
 const file=await open(temporary,'r');try{await file.sync();}finally{await file.close();}
 await rename(temporary,marker);const directory=await open(root,'r');try{await directory.sync();}finally{await directory.close();}
}
async function main(){
 const [action,workspace,...flags]=process.argv.slice(2);
 if(!['plan','enable','evict','discard-office','evict-legacy'].includes(action)||!workspace||!isAbsolute(workspace)||flags.some(f=>f!=='--acknowledge-local-office-history-loss'))throw Error('Usage: originals-main.ts plan|enable|evict|discard-office WORKSPACE [--acknowledge-local-office-history-loss]');
 const root=join(workspace,'storage'),database=join(workspace,'database.sqlite3'),db=openDatabase(database);
 try{
  if(action==='enable'){if((db.prepare('SELECT history_enabled FROM app_state WHERE id=1').get() as {history_enabled:number}).history_enabled)throw Error('DISABLE_LOCAL_HISTORY_FIRST');const candidates=originalDigests(database);if(candidates.length){const source=await originalResolver(database)(candidates[0]);if(!source)throw Error('RCLONE_ORIGINAL_UNAVAILABLE');await source.check();}db.prepare('UPDATE app_state SET direct_originals_enabled=1 WHERE id=1').run();await enableOriginals(root);console.log(JSON.stringify({mode:'rclone-originals',enabled:true}));return;}
  const local=await BlobStore.open(root),store=action==='evict'?new RcloneOriginalStore(root,local,originalResolver(database,{checkRemote:catalogueVerifier()})):local instanceof RcloneOriginalStore?local:new RcloneOriginalStore(root,local,originalResolver(database));
  if(action==='evict'&&!(local instanceof RcloneOriginalStore))throw Error('ENABLE_RCLONE_ORIGINALS_FIRST');
  const legacy=action==='evict-legacy'?await legacyReferences(db):[];
  const values=action==='evict-legacy'?legacy.map(r=>r.digest):action==='discard-office'?retiredOfficeDigests(db):originalDigests(database);
  if(action==='discard-office'&&!flags.includes('--acknowledge-local-office-history-loss'))throw Error('LOCAL_OFFICE_HISTORY_LOSS_ACKNOWLEDGEMENT_REQUIRED');
  const available=action==='discard-office'?legacyOriginalAvailability(db):undefined;
  let bytes=0,files=0,missing=0,failed=0;const errors:Record<string,number>={};
  let next=0;const run=async()=>{while(next<values.length){const value=values[next++];
   try{
    let size=0;
    if(action==='plan')size=(await lstat(join(root,'blobs',value.slice(0,2),value.slice(2)))).size;
    else if(action==='evict-legacy')size=await retireExternalCopy(db,root,legacy.find(r=>r.digest===value)!);
    else if(action==='discard-office')size=await discardOfficeCopy(db,root,value,available);
    else size=await store.evictConfirmed(value);
    if(size){bytes+=size;files++;}
   }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')missing++;else {failed++;const value=(error as any)?.code??(error as any)?.message;const code=typeof value==='string'&&/^[A-Z][A-Z0-9_]{2,100}$/.test(value)?value:'VERIFICATION_FAILED';errors[code]=(errors[code]??0)+1;}}
   if(next%100===0)console.log(JSON.stringify({action,files,bytes,missing,failed,progress:true}));
  }
  };await Promise.all(Array.from({length:action==='evict'?2:1},()=>run()));
  console.log(JSON.stringify({action,files,bytes,missing,failed,errors,done:true}));
 }finally{db.close();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])main().catch(error=>{const value=error?.code??error?.message;console.error(JSON.stringify({error:typeof value==='string'&&/^[A-Z][A-Z0-9_]{2,100}$/.test(value)?value:'RCLONE_ORIGINALS_MAINTENANCE_FAILED'}));process.exitCode=1;});
