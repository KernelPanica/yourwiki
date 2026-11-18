import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,lstat,rename,rm,chmod,utimes} from 'node:fs/promises';
import {join} from 'node:path';
import Sqlite from 'better-sqlite3';
import {RcloneClient,type RcloneRuntime} from '../rclone/client.ts';
import type {OriginalSource} from './rclone-originals.ts';
export type RcloneReference={digest:string;size:number;md5:string;reference:string;source_connection_id:string;access_connection_id:string;parent_id:string|null;binary_path:string;config_path:string;mount_path:string;staging_path:string};
/** A registered exact-byte reference outside the mounted root. No arbitrary
 * caller-supplied IDs reach this boundary; document ACL is checked by the API. */
export async function referencedSource(databasePath:string,root:string,ref:RcloneReference):Promise<OriginalSource>{
 if(!/^[a-f0-9]{64}$/.test(ref.digest)||!/^[a-f0-9]{32}$/.test(ref.md5)||!/^[-\w]{1,256}$/.test(ref.reference)||!Number.isSafeInteger(ref.size)||ref.size<0||ref.size>4*1024**3)throw Error('INVALID_REMOTE_STORAGE_REFERENCE');
 const runtime:RcloneRuntime={binary:ref.binary_path,config:ref.config_path,mount:ref.mount_path,staging:ref.staging_path},client=new RcloneClient(runtime);
 let parent=ref.parent_id&&/^[-\w]{1,256}$/.test(ref.parent_id)?ref.parent_id:null;
 const checkAccess=()=>{const db=new Sqlite(databasePath,{readonly:true,fileMustExist:true});try{if(!db.prepare("SELECT 1 FROM provider_connections WHERE id=? AND enabled=1 AND provider='google'").get(ref.access_connection_id))throw Error('PROVIDER_CONFIG_CHANGED');}finally{db.close();}client.check();};
 const check=async()=>{
  checkAccess();
  const list=async(query:string)=>{const rows=JSON.parse(await client.command(['backend','query','drive:',query],{check:checkAccess},180000));if(!Array.isArray(rows)||rows.length>100000)throw Error('INVALID_REMOTE_CATALOGUE');return rows.find((row:any)=>row.id===ref.reference);};
  let object=parent?await list("trashed = false and '"+parent+"' in parents"):undefined;
  if(!object)object=await list('trashed = false');
  if(!object||String(object.size)!==String(ref.size)||object.md5Checksum?.toLowerCase()!==ref.md5||object.mimeType?.startsWith('application/vnd.google-apps.'))throw Error('PROVIDER_SOURCE_CHANGED');
  parent=Array.isArray(object.parents)&&/^[-\w]{1,256}$/.test(object.parents[0])?object.parents[0]:null;
  checkAccess();
 };
 await check();
 const directory=join(root,'read-cache');await mkdir(directory,{recursive:true,mode:0o700});const path=join(directory,ref.digest);
 let ready=false;try{const info=await lstat(path);ready=info.isFile()&&!info.isSymbolicLink()&&info.size===ref.size&&info.mtimeMs>Date.now()-300000;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(!ready){
  const temporary=join(directory,randomUUID()+'.part');
  try{
   await client.command(['backend','copyid','drive:',ref.reference,temporary,'--immutable','--buffer-size','1M','--transfers','1','--checkers','1','--multi-thread-streams','0'],{check:checkAccess},180000);
   await chmod(temporary,0o600);const hash=createHash('sha256');let size=0;
   for await(const part of createReadStream(temporary)){size+=part.length;if(size>ref.size)throw Error('PROVIDER_SOURCE_CHANGED');hash.update(part);}
   if(size!==ref.size||hash.digest('hex')!==ref.digest)throw Error('PROVIDER_SOURCE_CHANGED');
   await check();await utimes(temporary,new Date(),new Date());await rename(temporary,path);
  }finally{await rm(temporary,{force:true});}
 }else await utimes(path,new Date(),new Date());
 return {digest:ref.digest,size:ref.size,md5:ref.md5,path,check,canEvict:()=>false};
}
