import {createHash} from 'node:crypto';
import {readTransaction,transaction,type Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {SecretConfigs} from './secret-config.ts';
import type {Provider} from './connection-types.ts';
import {connectionFields,connectionIdentity,connectionError,insertConnectionRecord} from './connection-records.ts';
export type LegacyConnectionInput={legacyKey:string;id:string;provider:Provider;label:string;path:string;folderId:string|null;encryptedConfig:string;now:number};
type Receipt={legacyKey:string;connectionId:string;state:'imported'};
/** Trusted stopped-source migration only. Never register this function as a user HTTP action. */
export function importLegacyConnection(db:Database,configs:SecretConfigs,input:LegacyConnectionInput):Receipt{
 try{
  const fields=['legacyKey','id','provider','label','path','folderId','encryptedConfig','now'],value=connectionFields(input,fields,fields),identity=connectionIdentity(value,false);
  if(typeof value.legacyKey!=='string'||!/^[A-Za-z0-9_.:-]{1,256}$/.test(value.legacyKey)||typeof value.encryptedConfig!=='string'||value.encryptedConfig.length<1||value.encryptedConfig.length>2097152||!Number.isSafeInteger(value.now)||Number(value.now)<0)connectionError();
  const token=value.encryptedConfig as string,legacyKey=value.legacyKey as string,tokenSha256=createHash('sha256').update(token).digest('hex'),sourceFingerprint=createHash('sha256').update(JSON.stringify({id:identity.id,provider:identity.provider,label:identity.label,path:identity.path,folderId:identity.folderId,tokenSha256})).digest('hex');
  const previous=()=>{const row=db.prepare('SELECT connection_id,source_fingerprint FROM provider_connection_imports WHERE legacy_key=?').get(legacyKey) as {connection_id:string;source_fingerprint:string}|undefined;if(!row)return undefined;if(row.source_fingerprint!==sourceFingerprint)connectionError('MIGRATION_MISMATCH');return {legacyKey,connectionId:row.connection_id,state:'imported' as const};};
  const accepted=readTransaction(db,previous);if(accepted)return accepted;
  connectionIdentity(value);let config:Record<string,unknown>;try{config=configs.decrypt(token);}catch{connectionError('CONFIG_UNAVAILABLE');}if(Object.hasOwn(config,'provider')&&config.provider!==identity.provider)connectionError();
  return transaction(db,()=>{const raced=previous();if(raced)return raced;insertConnectionRecord(db,identity,token,Number(value.now));db.prepare('INSERT INTO provider_connection_imports(legacy_key,connection_id,source_fingerprint,created_at) VALUES(?,?,?,?)').run(legacyKey,identity.id,sourceFingerprint,value.now);return {legacyKey,connectionId:identity.id,state:'imported'};});
 }catch(cause){if(cause instanceof DocumentError)throw cause;connectionError('CONFIG_UNAVAILABLE');}
}
