import {lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import Sqlite from 'better-sqlite3';
import {sha256File} from './backup.ts';
/** Verify accepted main-store references in addition to file manifest checksums.
 * In-progress upload/preparation namespaces are copied whole but are not main-store blobs yet. */
export async function verifyStoredReferences(workspace:string){
 const db=new Sqlite(join(workspace,'database.sqlite3'),{readonly:true,fileMustExist:true}),checked=new Set<string>();
 const has=(table:string)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
 const verify=async(digest:string,size?:number)=>{if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))throw new Error('INVALID_STORAGE_REFERENCE');const path=join(workspace,'storage','blobs',digest.slice(0,2),digest.slice(2)),info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||size!==undefined&&info.size!==size)throw new Error('MISSING_STORAGE_REFERENCE');if(!checked.has(digest)){if(await sha256File(path)!==digest)throw new Error('CORRUPT_STORAGE_BLOB');checked.add(digest);}return path;};
 try{
  for(const table of ['document_versions','recovery_copies','pdf_layer_versions','save_operations','content_attachments'])if(has(table))for(const row of db.prepare(`SELECT DISTINCT digest,size FROM ${table}`).iterate() as Iterable<{digest:string;size:number}>)await verify(row.digest,row.size);
  if(has('history_entries'))for(const row of db.prepare("SELECT DISTINCT digest,size FROM history_entries e WHERE import_id IS NULL OR EXISTS(SELECT 1 FROM history_imports i WHERE i.id=e.import_id AND i.state='committed')").iterate() as Iterable<{digest:string;size:number}>)await verify(row.digest,row.size);
  if(has('preview_manifests'))for(const row of db.prepare('SELECT DISTINCT manifest_digest FROM preview_manifests').iterate() as Iterable<{manifest_digest:string}>){const path=await verify(row.manifest_digest),info=await lstat(path);if(info.size>16*1024**2)throw new Error('INVALID_PREVIEW_MANIFEST');const manifest=JSON.parse(await readFile(path,'utf8'));if(!Array.isArray(manifest.artifacts))throw new Error('INVALID_PREVIEW_MANIFEST');for(const artifact of manifest.artifacts)await verify(artifact.digest,artifact.size);}
 }finally{db.close();}
}
