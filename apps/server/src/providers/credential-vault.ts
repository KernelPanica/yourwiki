import {ingressContext} from './ingress-guards.ts';
import type {Database} from '../database.ts';
import {AccessService} from '../access.ts';
import {SecretConfigs} from './secret-config.ts';
import {ProviderError} from './adapter.ts';
import type {Provider} from './connection-types.ts';
import type {DeliveryAttempt} from './delivery-attempts.ts';
export type AdapterConnection={provider:Provider;config:Record<string,unknown>;reference:string};
/** Worker-only credential boundary. Never inject into HTTP routes or DTOs. */
export class CredentialVault {
 private db:Database;private configs:SecretConfigs;
 constructor(db:Database,configs:SecretConfigs){this.db=db;this.configs=configs;}
 belongsToDatabase(db:Database){return this.db===db;}
 /** Trusted mirror binding capability; no browser user or imported provider ACL. */
 forBinding(input:{documentId:string;connectionId:string;connectionRevision:number;bindingGeneration:number}):AdapterConnection{
  let scope;try{scope=ingressContext(this.db,input.documentId);}catch{throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
  if(scope.connection_id!==input.connectionId||scope.connection_revision!==input.connectionRevision||scope.binding_generation!==input.bindingGeneration)throw new ProviderError('PROVIDER_CONFIG_CHANGED');
  const row=this.db.prepare('SELECT c.provider,c.encrypted_config,b.reference FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=? AND c.id=? AND c.revision=? AND c.enabled=1 AND b.generation=?').get(input.documentId,input.connectionId,input.connectionRevision,input.bindingGeneration) as any;
  try{return {provider:row.provider,reference:row.reference,config:this.configs.decrypt(row.encrypted_config)};}catch{throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
 }

 forAttempt(attempt:DeliveryAttempt):AdapterConnection{
  const access=new AccessService(this.db);if(!access.allows(attempt.authorId,attempt.documentId,'read')||!access.allows(attempt.authorId,attempt.documentId,'write'))throw new ProviderError('ACCESS_DENIED');
  const row=this.db.prepare('SELECT c.provider,c.encrypted_config,c.revision,c.enabled,b.reference,b.generation FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=?').get(attempt.documentId) as any;
  if(!row?.enabled||row.revision!==attempt.connectionRevision||row.generation!==attempt.bindingGeneration)throw new ProviderError('PROVIDER_CONFIG_CHANGED');
  try{return {provider:row.provider,reference:row.reference,config:this.configs.decrypt(row.encrypted_config)};}catch{throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
 }
}
