import {ingressContext} from './ingress-guards.ts';
import type {Database} from '../database.ts';
import {AccessService} from '../access.ts';
import {SecretConfigs} from './secret-config.ts';
import {ProviderError,type ProviderCheck} from './adapter.ts';
import type {Provider} from './connection-types.ts';
import type {DeliveryAttempt} from './delivery-attempts.ts';
import {googleManagedRecipients} from './google-grants.ts';
import {GoogleAuthPool,type GoogleAuthPoolOptions} from './google-auth-pool.ts';
export type AdapterConnection={provider:Provider;config:Record<string,unknown>;reference:string};
export type GoogleAuthorization={access:(options:ProviderCheck)=>Promise<string>;invalidate:(accessToken:string)=>void};
type Mint={id:string;revision:number;provider:Provider;check:()=>void};
/** Worker-only credential boundary. Never inject into HTTP routes or DTOs. */
export class CredentialVault {
 private db:Database;private configs:SecretConfigs;private auth:GoogleAuthPool;private minted=new WeakMap<AdapterConnection,Mint>();private closed=false;
 constructor(db:Database,configs:SecretConfigs,options:{google?:GoogleAuthPoolOptions}={}){this.db=db;this.configs=configs;this.auth=new GoogleAuthPool(db,configs,options.google);}
 belongsToDatabase(db:Database){return this.db===db&&!this.closed;}
 private live(){if(this.closed)throw new ProviderError('PROVIDER_CANCELLED');}
 private binding(input:{documentId:string;connectionId:string;connectionRevision:number;bindingGeneration:number}){
  this.live();try{const scope=ingressContext(this.db,input.documentId);if(scope.connection_id!==input.connectionId||scope.connection_revision!==input.connectionRevision||scope.binding_generation!==input.bindingGeneration)throw new Error();}catch{throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
 }
 /** Trusted mirror binding capability; no browser user or imported provider ACL. */
 forBinding(input:{documentId:string;connectionId:string;connectionRevision:number;bindingGeneration:number}):AdapterConnection{
  const pinned={...input};this.binding(pinned);const row=this.db.prepare('SELECT c.provider,c.encrypted_config,b.reference FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=? AND c.id=? AND c.revision=? AND c.enabled=1 AND b.generation=?').get(pinned.documentId,pinned.connectionId,pinned.connectionRevision,pinned.bindingGeneration) as any;
  try{const connection:AdapterConnection={provider:row.provider,reference:row.reference,config:this.configs.decrypt(row.encrypted_config)};this.minted.set(connection,{id:pinned.connectionId,revision:pinned.connectionRevision,provider:row.provider,check:()=>this.binding(pinned)});return connection;}catch{throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
 }
 private outgoing(input:Pick<DeliveryAttempt,'authorId'|'documentId'|'connectionRevision'|'bindingGeneration'>){
  this.live();try{const access=new AccessService(this.db);if(!access.allows(input.authorId,input.documentId,'read')||!access.allows(input.authorId,input.documentId,'write'))throw new ProviderError('ACCESS_DENIED');const row=this.db.prepare('SELECT c.id AS connection_id,c.provider,c.encrypted_config,c.revision,c.enabled,b.reference,b.generation FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=?').get(input.documentId) as any;if(!row?.enabled||row.revision!==input.connectionRevision||row.generation!==input.bindingGeneration)throw new ProviderError('PROVIDER_CONFIG_CHANGED');return row;}catch(error){if(error instanceof ProviderError)throw error;throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
 }
 forAttempt(attempt:DeliveryAttempt):AdapterConnection{
  const pinned={authorId:attempt.authorId,documentId:attempt.documentId,connectionRevision:attempt.connectionRevision,bindingGeneration:attempt.bindingGeneration},row=this.outgoing(pinned);
  try{const connection:AdapterConnection={provider:row.provider,reference:row.reference,config:this.configs.decrypt(row.encrypted_config)};this.minted.set(connection,{id:row.connection_id,revision:row.revision,provider:row.provider,check:()=>{this.outgoing(pinned);}});return connection;}catch{throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
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
 close():Promise<void>{this.closed=true;return this.auth.close();}
}
