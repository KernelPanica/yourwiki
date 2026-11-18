import {retiredOfficeDigests} from '../storage/originals-main.ts';
import {originalMetadataReferences} from '../storage/rclone-originals.ts';
import {lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import Sqlite from 'better-sqlite3';
import {sha256File} from './backup.ts';
/** Verify accepted main-store references in addition to file manifest checksums.
 * In-progress upload/preparation namespaces are copied whole but are not main-store blobs yet. */
export async function verifyStoredReferences(workspace:string){
 const db=new Sqlite(join(workspace,'database.sqlite3'),{readonly:true,fileMustExist:true}),checked=new Set<string>();
 try{
 const has=(table:string)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
 // In original mode a backup preserves settings/ACL and external references,
 // not a second snapshot of the Drive. Validate that boundary explicitly.
 let originals=new Map<string,number>();let external=false;
 try{const mode=JSON.parse(await readFile(join(workspace,'storage','rclone-originals.json'),'utf8'));if(mode.version!==1||mode.kind!=='rclone-originals')throw Error('INVALID_STORAGE_MODE');external=true;originals=originalMetadataReferences(db);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const discardable=external&&has('rclone_discarded_payloads')?new Set(retiredOfficeDigests(db)):new Set<string>();
 const verify=async(digest:string,size?:number,localOnly=false)=>{if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))throw new Error('INVALID_STORAGE_REFERENCE');if(!localOnly&&external){
  const remoteSize=originals.get(digest);
  if(remoteSize!==undefined){if(size!==undefined&&size!==remoteSize)throw Error('INVALID_REMOTE_STORAGE_REFERENCE');return '';}
  const receipt=has('rclone_remote_payloads')?db.prepare('SELECT size FROM rclone_remote_payloads WHERE digest=?').get(digest) as {size:number}|undefined:undefined;
  if(receipt&&!db.prepare("SELECT 1 FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision WHERE v.digest=? UNION ALL SELECT 1 FROM history_entries WHERE digest=? UNION ALL SELECT 1 FROM recovery_copies WHERE digest=? UNION ALL SELECT 1 FROM content_attachments WHERE digest=? UNION ALL SELECT 1 FROM pdf_layer_versions WHERE digest=? UNION ALL SELECT 1 FROM save_operations WHERE digest=? AND state='staged' LIMIT 1").get(digest,digest,digest,digest,digest,digest)){
   if(size!==undefined&&size!==receipt.size)throw Error('INVALID_EXTERNAL_STORAGE_RECEIPT');return '';
  }
  const retired=has('rclone_discarded_payloads')?db.prepare('SELECT size FROM rclone_discarded_payloads WHERE digest=?').get(digest) as {size:number}|undefined:undefined;
  if(retired&&discardable.has(digest)){if(size!==undefined&&size!==retired.size)throw Error('INVALID_RETIRED_STORAGE_REFERENCE');return '';}
 }
 const path=join(workspace,'storage','blobs',digest.slice(0,2),digest.slice(2)),info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||size!==undefined&&info.size!==size)throw new Error('MISSING_STORAGE_REFERENCE');if(!checked.has(digest)){if(await sha256File(path)!==digest)throw new Error('CORRUPT_STORAGE_BLOB');checked.add(digest);}return path;};
  for(const table of ['document_versions','recovery_copies','pdf_layer_versions','save_operations','content_attachments'])if(has(table)){
   if(table==='document_versions'){
    for(const row of db.prepare("SELECT v.digest,v.size,(v.revision=d.local_revision AND (b.document_id IS NULL OR b.confirmed_revision<>v.revision OR c.enabled=1 AND (CASE WHEN json_valid(b.fingerprint) THEN json_extract(b.fingerprint,'$[0]') ELSE '' END)<>'rclone-drive-v1' OR c.enabled=0 AND d.format NOT IN ('docx','xlsx','pptx','doc','xls','ppt','odt','ods','odp') AND NOT EXISTS(SELECT 1 FROM rclone_external_payloads x WHERE x.digest=v.digest AND x.size=v.size))) AS mustLocal FROM document_versions v JOIN documents d ON d.id=v.document_id LEFT JOIN provider_source_bindings b ON b.document_id=d.id LEFT JOIN provider_connections c ON c.id=b.connection_id").iterate() as Iterable<{digest:string;size:number;mustLocal:number}>)await verify(row.digest,row.size,external&&row.mustLocal===1);
   }else if(table==='save_operations'){for(const row of db.prepare('SELECT DISTINCT digest,size,state FROM save_operations').iterate() as Iterable<{digest:string;size:number;state:string}>)await verify(row.digest,row.size,row.state==='staged');}
   else for(const row of db.prepare(`SELECT DISTINCT digest,size FROM ${table}`).iterate() as Iterable<{digest:string;size:number}>)await verify(row.digest,row.size,['recovery_copies','pdf_layer_versions','content_attachments'].includes(table));
  }
  if(has('history_entries'))for(const row of db.prepare("SELECT DISTINCT digest,size FROM history_entries e WHERE import_id IS NULL OR EXISTS(SELECT 1 FROM history_imports i WHERE i.id=e.import_id AND i.state='committed')").iterate() as Iterable<{digest:string;size:number}>)await verify(row.digest,row.size);
  if(has('preview_manifests'))for(const row of db.prepare('SELECT DISTINCT manifest_digest FROM preview_manifests').iterate() as Iterable<{manifest_digest:string}>){const path=await verify(row.manifest_digest,undefined,true),info=await lstat(path);if(info.size>16*1024**2)throw new Error('INVALID_PREVIEW_MANIFEST');const manifest=JSON.parse(await readFile(path,'utf8'));if(!Array.isArray(manifest.artifacts))throw new Error('INVALID_PREVIEW_MANIFEST');for(const artifact of manifest.artifacts)await verify(artifact.digest,artifact.size,artifact.digest!==manifest.sourceDigest);}
 }finally{db.close();}
}
