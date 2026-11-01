import type {Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {providerNames,type CreateConnection} from './connection-types.ts';
export type ConnectionIdentity=Omit<CreateConnection,'config'>;
export function connectionError(code='INVALID_REQUEST'):never{throw new DocumentError(code);}
export function connectionId(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value);}
export function connectionFields(value:unknown,allowed:string[],required:string[]){if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.getOwnPropertySymbols(value).length)connectionError();const fields=Object.create(null) as Record<string,unknown>;for(const key of Object.getOwnPropertyNames(value)){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!allowed.includes(key)||!descriptor||!('value' in descriptor))connectionError();fields[key]=descriptor.value;}if(required.some(key=>!Object.hasOwn(fields,key)))connectionError();return fields;}
export function connectionLabel(value:unknown):value is string{return typeof value==='string'&&value.length<=400&&Buffer.from(value).toString('utf8')===value&&Array.from(value).length>=1&&Array.from(value).length<=200;}
function mountPath(value:unknown):value is string{if(typeof value!=='string'||value.length>4096||Buffer.from(value).toString('utf8')!==value||!value.startsWith('/')||Array.from(value).length>2048)return false;if(value==='/')return true;const parts=value.slice(1).split('/');return parts.length<=32&&parts.every(part=>part.length>0&&Array.from(part).length<=200&&!['.','..'].includes(part)&&!/[/\\\0<>:"|?*]/.test(part)&&!/[ .]$/.test(part)&&!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));}

export function connectionIdentity(input:Record<string,unknown>,bindingRules=true):ConnectionIdentity{
 if(!connectionId(input.id)||!providerNames.includes(input.provider as any)||!connectionLabel(input.label)||!mountPath(input.path)||input.folderId!==null&&!connectionId(input.folderId)||(bindingRules&&(input.path==='/'?input.folderId!==null:input.folderId===null)))connectionError();
 return {id:input.id as string,provider:input.provider as ConnectionIdentity['provider'],label:input.label as string,path:input.path as string,folderId:input.folderId as string|null};
}
/** Caller owns a short IMMEDIATE transaction; trusted importer never fabricates a user. */
export function insertConnectionRecord(db:Database,value:ConnectionIdentity,cipher:string,now:number){
 if(!db.inTransaction)throw new Error('Connection insert requires a transaction');connectionIdentity(value);if(!Number.isSafeInteger(now)||now<0)connectionError();
 if(value.folderId!==null&&!db.prepare("SELECT 1 FROM resources WHERE id=? AND kind='folder' AND trashed=0").get(value.folderId))connectionError();
 if(db.prepare('SELECT 1 FROM provider_connections WHERE id=? UNION ALL SELECT 1 FROM provider_mounts WHERE path=? OR folder_id=? LIMIT 1').get(value.id,value.path,value.folderId))connectionError('CONNECTION_EXISTS');
 db.prepare('INSERT INTO provider_connections(id,provider,label,encrypted_config,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(value.id,value.provider,value.label,cipher,now,now);db.prepare('INSERT INTO provider_mounts(connection_id,path,folder_id) VALUES(?,?,?)').run(value.id,value.path,value.folderId);db.prepare('INSERT INTO provider_connection_changes(connection_id,revision,created_at) VALUES(?,1,?)').run(value.id,now);
}
