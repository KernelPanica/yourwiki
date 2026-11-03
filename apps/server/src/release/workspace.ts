import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readdir,rename,rm,writeFile,lstat,open} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {openDatabase,transaction} from '../database.ts';
import {hashPassword} from '../auth/passwords.ts';
import {BlobStore} from '../storage/blobs.ts';
export function workspacePaths(root:string){if(!isAbsolute(root)||root.includes('\0'))throw new Error('INVALID_WORKSPACE');return {root,databasePath:join(root,'database.sqlite3'),storagePath:join(root,'storage'),secretKeyPath:join(root,'encryption.key')};}
export function publicOrigin(value:string){const url=new URL(value);if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('INVALID_PUBLIC_ORIGIN');return url.origin;}
export async function syncDirectory(path:string){const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}
export async function durableFile(path:string,bytes:string|Buffer){const file=await open(path,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}}
export async function ensureFreshRoot(dataRoot:string){workspacePaths(dataRoot);await mkdir(dataRoot,{recursive:true,mode:0o700});if((await lstat(dataRoot)).isSymbolicLink())throw new Error('INVALID_WORKSPACE');const existing=await readdir(dataRoot);if(existing.some(name=>name!=='release.lock'))throw new Error('EXISTING_DATA');}
/** Explicit new install only. A complete staged directory becomes visible in one rename. */
export async function bootstrap(dataRoot:string,input:{username:string;displayName:string;password:string;publicUrl:string}){
 const origin=publicOrigin(input.publicUrl);if(!/^[\p{L}\p{N}_.@-]{1,150}$/u.test(input.username)||!input.displayName.trim()||input.displayName.length>150||input.password.length<12||Buffer.byteLength(input.password)>4096)throw new Error('INVALID_INSTALLATION');
 await ensureFreshRoot(dataRoot);const temporary=join(dataRoot,'.install-'+randomUUID()),paths=workspacePaths(temporary);await mkdir(temporary,{mode:0o700});
 try{const encoded=await hashPassword(input.password);await durableFile(paths.secretKeyPath,randomBytes(32).toString('base64url')+'\n');await BlobStore.open(paths.storagePath);const db=openDatabase(paths.databasePath);try{transaction(db,()=>{const userId=randomUUID(),groupId=randomUUID();db.prepare('INSERT INTO users(id,username,display_name,password_hash,admin_role) VALUES(?,?,?,?,?)').run(userId,input.username,input.displayName.trim(),encoded,'giga');db.prepare('INSERT INTO groups(id,name) VALUES(?,?)').run(groupId,'Members');db.prepare('INSERT INTO memberships(user_id,group_id) VALUES(?,?)').run(userId,groupId);});db.pragma('wal_checkpoint(TRUNCATE)');}finally{db.close();}await durableFile(join(temporary,'installation.json'),JSON.stringify({version:1,publicUrl:origin,createdAt:Date.now()})+'\n');await syncDirectory(temporary);await rename(temporary,join(dataRoot,'workspace'));await syncDirectory(dataRoot);return {status:'initialized',publicUrl:origin};}catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
}

export async function syncTree(path:string){for(const entry of await readdir(path,{withFileTypes:true})){const child=join(path,entry.name);if(entry.isDirectory())await syncTree(child);else if(entry.isFile()){const file=await open(child,'r');try{await file.sync();}finally{await file.close();}}else throw new Error('UNSAFE_WORKSPACE_ENTRY');}await syncDirectory(path);}
