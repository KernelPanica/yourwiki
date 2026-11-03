import {googleFileId} from './google-read-http.ts';
import {ingressContext} from './ingress-guards.ts';
import type {Database} from '../database.ts';
import {AccessService} from '../access.ts';
import {SecretConfigs} from './secret-config.ts';
import {ProviderError,type ProviderCheck} from './adapter.ts';
import type {Provider} from './connection-types.ts';
import type {DeliveryAttempt} from './delivery-attempts.ts';
import {googleManagedRecipients} from './google-grants.ts';
import {GoogleAuthPool,type GoogleAuthPoolOptions} from './google-auth-pool.ts';
import {GoogleUploadJournal} from './google-upload-journal.ts';
export type AdapterConnection={provider:Provider;config:Record<string,unknown>;reference:string};
export type GoogleAuthorization={access:(options:ProviderCheck)=>Promise<string>;invalidate:(accessToken:string)=>void};
type Mint={documentId:string;id:string;revision:number;provider:Provider;check:()=>void;attempt?:DeliveryAttempt};
/** Worker-only credential boundary. Never inject into HTTP routes or DTOs. */
export class CredentialVault {
 private db:Database;private configs:SecretConfigs;private auth:GoogleAuthPool;private minted=new WeakMap<AdapterConnection,Mint>();private closed=false;private ownsAuth=true;
 constructor(db:Database,configs:SecretConfigs,options:{google?:GoogleAuthPoolOptions;authPool?:GoogleAuthPool}={}){this.db=db;this.configs=configs;if(options.authPool&&!options.authPool.belongsToDatabase(db))throw new Error('Google auth pool requires the worker database');this.ownsAuth=!options.authPool;this.auth=options.authPool??new GoogleAuthPool(db,configs,options.google);}
 belongsToDatabase(db:Database){return this.db===db&&!this.closed;}
 private live(){if(this.closed)throw new ProviderError('PROVIDER_CANCELLED');}
 private binding(input:{documentId:string;connectionId:string;connectionRevision:number;bindingGeneration:number}){
  this.live();try{const scope=ingressContext(this.db,input.documentId);if(scope.connection_id!==input.connectionId||scope.connection_revision!==input.connectionRevision||scope.binding_generation!==input.bindingGeneration)throw new Error();}catch{throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
 }
 /** Trusted mirror binding capability; no browser user or imported provider ACL. */
 forBinding(input:{documentId:string;connectionId:string;connectionRevision:number;bindingGeneration:number}):AdapterConnection{
  const pinned={...input};this.binding(pinned);const row=this.db.prepare('SELECT c.provider,c.encrypted_config,b.reference FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=? AND c.id=? AND c.revision=? AND c.enabled=1 AND b.generation=?').get(pinned.documentId,pinned.connectionId,pinned.connectionRevision,pinned.bindingGeneration) as any;
  try{const connection:AdapterConnection={provider:row.provider,reference:row.reference,config:this.configs.decrypt(row.encrypted_config)};this.minted.set(connection,{documentId:pinned.documentId,id:pinned.connectionId,revision:pinned.connectionRevision,provider:row.provider,check:()=>this.binding(pinned)});return connection;}catch{throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
 }
 private outgoing(input:Pick<DeliveryAttempt,'authorId'|'documentId'|'connectionRevision'|'bindingGeneration'>){
  this.live();try{const access=new AccessService(this.db);if(!access.allows(input.authorId,input.documentId,'read')||!access.allows(input.authorId,input.documentId,'write'))throw new ProviderError('ACCESS_DENIED');const row=this.db.prepare('SELECT c.id AS connection_id,c.provider,c.encrypted_config,c.revision,c.enabled,b.reference,b.generation FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=?').get(input.documentId) as any;if(!row?.enabled||row.revision!==input.connectionRevision||row.generation!==input.bindingGeneration)throw new ProviderError('PROVIDER_CONFIG_CHANGED');return row;}catch(error){if(error instanceof ProviderError)throw error;throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
 }
 forAttempt(attempt:DeliveryAttempt):AdapterConnection{
  const pinned={authorId:attempt.authorId,documentId:attempt.documentId,connectionRevision:attempt.connectionRevision,bindingGeneration:attempt.bindingGeneration},row=this.outgoing(pinned);
  try{const connection:AdapterConnection={provider:row.provider,reference:row.reference,config:this.configs.decrypt(row.encrypted_config)};this.minted.set(connection,{documentId:pinned.documentId,id:row.connection_id,revision:row.revision,provider:row.provider,attempt:{...attempt,job:{...attempt.job,payload:{...attempt.job.payload}}},check:()=>{this.outgoing(pinned);}});return connection;}catch{throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
 }
 /** Outgoing-only private receipt capability; caller copies cannot select another attempt. */
 googleUploads(connection:AdapterConnection){
  this.live();const scope=this.minted.get(connection);if(!scope?.attempt||scope.provider!=='google')throw new ProviderError('PROVIDER_CONFIG_CHANGED');scope.check();const attempt=scope.attempt,journal=new GoogleUploadJournal(this.db,this.configs),check=()=>{this.live();scope.check();};
  return Object.freeze({
   reserve:(now?:number)=>{check();return journal.reserve(attempt,now);},
   load:(now?:number)=>{check();return journal.load(attempt,now);},
   markInitiating:(now?:number)=>{check();journal.markInitiating(attempt,now);},
   attach:(url:string,now?:number)=>{check();journal.attach(attempt,url,now);},
   markDispatched:(now?:number)=>{check();journal.markDispatched(attempt,now);},
   markUnknown:(now?:number)=>{this.live();journal.markUnknown(attempt,now);}
  });
 }
 /** Canonical internal source descriptor. Never serialize root/reference as a public DTO. */
 googleSource(connection:AdapterConnection):Readonly<{root:string;reference:string;format:string;fingerprint:string;check:()=>void;checkBaseline:()=>void}>{
  this.live();const scope=this.minted.get(connection);if(!scope||scope.provider!=='google')throw new ProviderError('PROVIDER_CONFIG_CHANGED');scope.check();
  try{
   const row=this.db.prepare('SELECT c.encrypted_config,b.reference,b.fingerprint,d.format FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id JOIN documents d ON d.id=b.document_id WHERE b.document_id=? AND c.id=? AND c.revision=? AND c.enabled=1').get(scope.documentId,scope.id,scope.revision) as {encrypted_config:string;reference:string;fingerprint:string;format:string}|undefined;
   if(!row)throw new Error();const config=this.configs.decrypt(row.encrypted_config),root=googleFileId(config.root),reference=googleFileId(row.reference);if(typeof row.format!=='string'||!/^[a-z0-9][a-z0-9.-]{0,31}$/.test(row.format))throw new Error();scope.check();
   const format=row.format,fingerprint=row.fingerprint;if(typeof fingerprint!=='string'||!fingerprint||fingerprint.length>1024||/[\x00-\x1f\x7f]/.test(fingerprint))throw new Error();
   return Object.freeze({root,reference,format,fingerprint,check:()=>scope.check(),checkBaseline:()=>{scope.check();const current=this.db.prepare('SELECT b.reference,b.fingerprint,d.format FROM provider_source_bindings b JOIN documents d ON d.id=b.document_id WHERE b.document_id=?').get(scope.documentId) as {reference:string;fingerprint:string;format:string}|undefined;if(!current||current.reference!==reference||current.fingerprint!==fingerprint||current.format!==format)throw new ProviderError('PROVIDER_CONFLICT');}});
  }catch(error){if(error instanceof ProviderError&&error.code==='PROVIDER_CANCELLED')throw error;throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
 }
 /** Opaque object identity prevents callers from borrowing another vault/connection's shared auth. */
 google(connection:AdapterConnection):GoogleAuthorization{
  this.live();const scope=this.minted.get(connection);if(!scope||scope.provider!=='google')throw new ProviderError('PROVIDER_CONFIG_CHANGED');scope.check();
  return Object.freeze({
   access:async(options:ProviderCheck)=>{scope.check();return this.auth.access(scope.id,scope.revision,{signal:options.signal,check:async()=>{scope.check();await options.check();scope.check();}});},
   invalidate:(token:string)=>{scope.check();this.auth.invalidate(scope.id,scope.revision,token);}
  });
 }
 /** Scoped managed-sharing evidence for metadata/ancestor checks, never local ACL authority. */
 googleRecipients(connection:AdapterConnection):(reference:string,options:ProviderCheck)=>Promise<readonly string[]>{
  this.live();const scope=this.minted.get(connection);if(!scope||scope.provider!=='google')throw new ProviderError('PROVIDER_CONFIG_CHANGED');scope.check();
  return async(reference,options)=>{
   const check=async()=>{if(options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');scope.check();await options.check();scope.check();if(options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');};
   await check();const recipients=googleManagedRecipients(this.db,scope.id,scope.revision,reference);await check();return recipients;
  };
 }
 close():Promise<void>{this.closed=true;return this.ownsAuth?this.auth.close():Promise.resolve();}
}
