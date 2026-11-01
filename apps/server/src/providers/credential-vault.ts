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
 forAttempt(attempt:DeliveryAttempt):AdapterConnection{
  const access=new AccessService(this.db);if(!access.allows(attempt.authorId,attempt.documentId,'read')||!access.allows(attempt.authorId,attempt.documentId,'write'))throw new ProviderError('ACCESS_DENIED');
  const row=this.db.prepare('SELECT c.provider,c.encrypted_config,c.revision,c.enabled,b.reference,b.generation FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=?').get(attempt.documentId) as any;
  if(!row?.enabled||row.revision!==attempt.connectionRevision||row.generation!==attempt.bindingGeneration)throw new ProviderError('PROVIDER_CONFIG_CHANGED');
  try{return {provider:row.provider,reference:row.reference,config:this.configs.decrypt(row.encrypted_config)};}catch{throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
 }
}
