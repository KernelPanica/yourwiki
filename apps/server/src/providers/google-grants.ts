import {createHash} from 'node:crypto';
import {readTransaction,transaction,type Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {connectionFields,connectionId,connectionError} from './connection-records.ts';
import {googleFileId} from './google-read-http.ts';
import {ProviderError} from './adapter.ts';
const key=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const timestamp=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Trusted stopped-source migration only, never register as a browser action.
 * Receipts retain original status; recognizing a managed recipient never grants local rights. */
export function importLegacyGoogleGrant(db:Database,input:unknown){
 try{
  const fields=['legacyKey','connectionLegacyKey','connectionId','reference','objectKey','legacyUserKey','recipient','desiredRole','appliedRole','permissionId','status','attemptedAt','now'];
  const value=connectionFields(input,fields,fields);
  if(!key(value.legacyKey)||!key(value.connectionLegacyKey)||!connectionId(value.connectionId)||!timestamp(value.now)||value.legacyUserKey!==null&&!key(value.legacyUserKey)||value.attemptedAt!==null&&!timestamp(value.attemptedAt))connectionError();
  try{googleFileId(value.reference);}catch{connectionError();}
  if(typeof value.objectKey!=='string'||value.objectKey!==hash(':'+value.reference)||typeof value.recipient!=='string'||value.recipient.length>320||Buffer.from(value.recipient).toString('utf8')!==value.recipient||value.recipient!==''&&(!value.recipient.includes('@')||/[\x00-\x20\x7f]/.test(value.recipient))||!['','read','write'].includes(value.desiredRole as string)||!['','read','write'].includes(value.appliedRole as string)||typeof value.permissionId!=='string'||value.permissionId.length>255||/[^\x21-\x7e]/.test(value.permissionId)||!['pending','synced','failed','revoked'].includes(value.status as string))connectionError();
  const now=value.now,identity=Object.fromEntries(fields.filter(field=>field!=='now').map(field=>[field,value[field]])),sourceFingerprint=hash(JSON.stringify(identity));
  const receipt=()=>({legacyKey:value.legacyKey as string,connectionId:value.connectionId as string,state:'imported' as const});
  const previous=()=>{const row=db.prepare('SELECT source_fingerprint FROM provider_google_grant_imports WHERE legacy_key=?').get(value.legacyKey) as {source_fingerprint:string}|undefined;if(!row)return;if(row.source_fingerprint!==sourceFingerprint)connectionError('MIGRATION_MISMATCH');return receipt();};
  const accepted=readTransaction(db,previous);if(accepted)return accepted;
  return transaction(db,()=>{
   const raced=previous();if(raced)return raced;
   const mount=db.prepare("SELECT 1 FROM provider_connection_imports i JOIN provider_connections c ON c.id=i.connection_id WHERE i.legacy_key=? AND c.id=? AND c.provider='google' AND c.enabled=1").get(value.connectionLegacyKey,value.connectionId);if(!mount)connectionError();
   db.prepare('INSERT INTO provider_google_grant_imports(legacy_key,connection_legacy_key,connection_id,reference,object_key,legacy_user_key,recipient,desired_role,applied_role,permission_id,status,attempted_at,source_fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(value.legacyKey,value.connectionLegacyKey,value.connectionId,value.reference,value.objectKey,value.legacyUserKey,value.recipient,value.desiredRole,value.appliedRole,value.permissionId,value.status,value.attemptedAt,sourceFingerprint,now);
   return receipt();
  });
 }catch(error){if(error instanceof DocumentError)throw error;connectionError('CONFIG_UNAVAILABLE');}
}
/** Private bounded worker query, scoped by current connection revision before every lookup.
 * Google file IDs are global: legacy google_managed matched object_key across mounts.
 * Ownership/root verification remains mandatory; these receipts alone authorize no source read.
 * Includes pending/failed/revoked historical recipients as legacy google_managed did.
 * A row does not claim successful sharing and never changes effective local ACL. */
export function googleManagedRecipients(db:Database,connection:string,revision:number,reference:string):readonly string[]{
 try{
  if(!connectionId(connection)||!Number.isSafeInteger(revision)||revision<1)throw new Error();googleFileId(reference);
  return readTransaction(db,()=>{
   if(!db.prepare("SELECT 1 FROM provider_connections WHERE id=? AND provider='google' AND enabled=1 AND revision=?").get(connection,revision))throw new Error();
   const rows=db.prepare("SELECT recipient FROM provider_google_grant_imports WHERE reference=? AND recipient!='' ORDER BY legacy_key LIMIT 10001").all(reference) as {recipient:string}[];
   if(rows.length>10000)throw new Error();return Object.freeze([...new Set(rows.map(row=>row.recipient.toLowerCase()))]);
  });
 }catch{throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
}
