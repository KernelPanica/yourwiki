import {connectionError as error,connectionId as opaque,connectionFields as record,connectionLabel as label,connectionIdentity,insertConnectionRecord} from './connection-records.ts';
import {isDeepStrictEqual} from 'node:util';
import {transaction,readTransaction,type Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {SecretError} from './secret-errors.ts';
import {SecretConfigs} from './secret-config.ts';
import {type ConnectionMetadata,type CreateConnection,type UpdateConnection} from './connection-types.ts';
const columns='c.id,c.provider,c.label,m.path,m.folder_id,c.revision,c.enabled,c.created_at,c.updated_at';
const identity=['root','repository','branch','host','port','share','host_key','drive_id','username','domain'],secrets=new Set(['client_secret','refresh_token','token','password','private_key','key_passphrase']);
type Row={id:string;provider:ConnectionMetadata['provider'];label:string;path:string;folder_id:string|null;revision:number;enabled:number;created_at:number;updated_at:number};
function metadata(row:Row):ConnectionMetadata{return {id:row.id,provider:row.provider,label:row.label,path:row.path,folderId:row.folder_id,revision:row.revision,enabled:row.enabled===1,state:'configured',createdAt:row.created_at,updatedAt:row.updated_at};}
/** Central account metadata only. No adapter/network calls or public credential accessor. */
export class ProviderConnections{
 private db:Database;private configs:SecretConfigs;private clock:()=>number;
 constructor(db:Database,configs:SecretConfigs,options:{clock?:()=>number}={}){this.db=db;this.configs=configs;this.clock=options.clock??Date.now;}
 /** Internal app wiring guard; never serialized as metadata. */
 belongsToDatabase(db:Database){return this.db===db;}
 private admin(userId:string){const user=this.db.prepare('SELECT active,admin_role FROM users WHERE id=?').get(userId) as {active:number;admin_role:string}|undefined;if(!user?.active||user.admin_role!=='giga')error('ACCESS_DENIED');}
 private row(id:string){return this.db.prepare('SELECT '+columns+' FROM provider_connections c JOIN provider_mounts m ON m.connection_id=c.id WHERE c.id=?').get(id) as Row|undefined;}
 private current(id:string){if(!opaque(id))error();const row=this.row(id);if(!row)error('NOT_FOUND');return row;}
 private wrap<T>(action:()=>T):T{try{return action();}catch(cause){if(cause instanceof DocumentError)throw cause;if(cause instanceof SecretError){if(['INVALID_SECRET_CONFIG','SECRET_TOO_LARGE'].includes(cause.code))error();error('CONFIG_UNAVAILABLE');}error('CONFIG_UNAVAILABLE');}}
 get(userId:string,id:string){return readTransaction(this.db,()=>{this.admin(userId);return metadata(this.current(id));});}
 list(userId:string,options:{after?:string;limit?:number}={}){return readTransaction(this.db,()=>{this.admin(userId);const value=record(options,['after','limit'],[]),limit=value.limit===undefined?50:value.limit;if(!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>200||value.after!==undefined&&!opaque(value.after))error();const rows=this.db.prepare('SELECT '+columns+' FROM provider_connections c JOIN provider_mounts m ON m.connection_id=c.id WHERE c.id>? ORDER BY c.id LIMIT ?').all(value.after??'',Number(limit)+1) as Row[],items=rows.slice(0,Number(limit)).map(metadata);return {items,nextCursor:rows.length>Number(limit)?items.at(-1)!.id:null};});}
 create(userId:string,input:CreateConnection){return this.wrap(()=>transaction(this.db,()=>{
  this.admin(userId);const value=record(input,['id','provider','label','path','folderId','config'],['id','provider','label','path','folderId','config']);
  const identity=connectionIdentity(value);
  const cipher=this.configs.encrypt(value.config as Record<string,unknown>),config=this.configs.decrypt(cipher);if(Object.hasOwn(config,'provider')&&config.provider!==value.provider)error();const now=this.clock();if(!Number.isSafeInteger(now)||now<0)error();
  insertConnectionRecord(this.db,identity,cipher,now);return metadata(this.current(identity.id));
 }));}
 private event(id:string,revision:number,now:number){this.db.prepare('INSERT INTO provider_connection_changes(connection_id,revision,created_at) VALUES(?,?,?)').run(id,revision,now);}
 /** Remove the mount and credentials, retaining immutable historical receipts. No provider IO. */
 remove(userId:string,id:string,input:unknown){return this.wrap(()=>transaction(this.db,()=>{
  this.admin(userId);const before=this.current(id),value=record(input,['baseRevision'],['baseRevision']);
  if(!Number.isSafeInteger(value.baseRevision)||Number(value.baseRevision)<1)error();
  if(value.baseRevision!==before.revision||before.revision>=Number.MAX_SAFE_INTEGER)error('CONFLICT');
  // Disconnecting an empty/broken mount is safe. Bound data needs an explicit migration first.
  for(const table of ['provider_source_bindings','google_storage_exports','google_storage_folder_exports','provider_google_folders','rclone_drive_folder_exports','provider_backup_settings','provider_backups']){
   if(this.db.prepare('SELECT 1 FROM '+table+' WHERE connection_id=? LIMIT 1').get(id))error('CONNECTION_IN_USE');
  }
  const now=this.clock();this.db.prepare('UPDATE provider_connections SET enabled=0,encrypted_config=?,revision=revision+1,updated_at=? WHERE id=?').run(this.configs.encrypt({}),now,id);
  this.db.prepare('DELETE FROM provider_google_connect_states WHERE connection_id=?').run(id);
  this.db.prepare('DELETE FROM provider_oauth_refreshes WHERE connection_id=?').run(id);
  this.db.prepare('DELETE FROM google_storage_mounts WHERE connection_id=?').run(id);
  this.db.prepare('DELETE FROM provider_mounts WHERE connection_id=?').run(id);
  this.event(id,before.revision+1,now);return {removed:true};
 }));}
 update(userId:string,id:string,input:UpdateConnection){return this.wrap(()=>transaction(this.db,()=>{
  this.admin(userId);const before=this.current(id),value=record(input,['baseRevision','label','enabled','configPatch'],['baseRevision']);if(!Number.isSafeInteger(value.baseRevision)||Number(value.baseRevision)<1||value.label!==undefined&&!label(value.label)||value.enabled!==undefined&&typeof value.enabled!=='boolean')error();if(value.baseRevision!==before.revision)error('CONFLICT');let cipher:string|undefined;
  if(Object.hasOwn(value,'configPatch')){
   const stored=this.db.prepare('SELECT encrypted_config FROM provider_connections WHERE id=?').get(id) as {encrypted_config:string};let original:Record<string,unknown>;try{original=this.configs.decrypt(stored.encrypted_config);}catch{error('CONFIG_UNAVAILABLE');}
   const patch=this.configs.decrypt(this.configs.encrypt(value.configPatch as Record<string,unknown>));for(const field of identity)if(Object.hasOwn(patch,field)&&!isDeepStrictEqual(patch[field],original[field]))error('CONNECTION_IDENTITY_IMMUTABLE');if(Object.hasOwn(patch,'provider')&&patch.provider!==before.provider)error('CONNECTION_IDENTITY_IMMUTABLE');
   const merged=Object.create(null);for(const [key,item] of Object.entries(original))Object.defineProperty(merged,key,{value:item,enumerable:true,writable:true,configurable:true});for(const [key,item] of Object.entries(patch)){if(secrets.has(key)&&item==='')continue;Object.defineProperty(merged,key,{value:item,enumerable:true,writable:true,configurable:true});}const mergedCipher=this.configs.encrypt(merged);if(!isDeepStrictEqual(this.configs.decrypt(mergedCipher),original))cipher=mergedCipher;
  }
  const nextLabel=value.label===undefined?before.label:value.label,nextEnabled=value.enabled===undefined?before.enabled:value.enabled?1:0;if(nextLabel===before.label&&nextEnabled===before.enabled&&cipher===undefined)return metadata(before);if(before.revision>=Number.MAX_SAFE_INTEGER)error('CONFLICT');const now=this.clock();if(!Number.isSafeInteger(now)||now<0)error();
  if(cipher===undefined)this.db.prepare('UPDATE provider_connections SET label=?,enabled=?,revision=revision+1,updated_at=? WHERE id=?').run(nextLabel,nextEnabled,now,id);else this.db.prepare('UPDATE provider_connections SET label=?,enabled=?,encrypted_config=?,revision=revision+1,updated_at=? WHERE id=?').run(nextLabel,nextEnabled,cipher,now,id);this.event(id,before.revision+1,now);return metadata(this.current(id));
 }));}
}
