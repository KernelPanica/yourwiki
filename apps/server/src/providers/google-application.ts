import type {Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {SecretConfigs} from './secret-config.ts';
export class GoogleApplication{
 private db:Database;private secrets:SecretConfigs;
 constructor(db:Database,secrets:SecretConfigs){this.db=db;this.secrets=secrets;}
 credentials(){const row=this.db.prepare('SELECT encrypted_config FROM google_application_settings WHERE id=1').get() as {encrypted_config:string}|undefined;
  if(row)return this.secrets.decrypt(row.encrypted_config);
  // Existing installations keep their application credentials without re-entry.
  for(const connection of this.db.prepare("SELECT encrypted_config FROM provider_connections WHERE provider='google' ORDER BY created_at,id").all() as {encrypted_config:string}[]){try{const config=this.secrets.decrypt(connection.encrypted_config);if(config.client_id&&config.client_secret)return {client_id:config.client_id,client_secret:config.client_secret};}catch{}}
  return {};
 }
 settings(){const c=this.credentials();return {clientId:typeof c.client_id==='string'?c.client_id:'',hasSecret:typeof c.client_secret==='string'&&!!c.client_secret,revision:(this.db.prepare('SELECT revision FROM google_application_settings WHERE id=1').get() as {revision:number}|undefined)?.revision??0};}
 update(value:Record<string,unknown>){const prior=this.settings();if(value.baseRevision!==prior.revision||typeof value.clientId!=='string'||!value.clientId||value.clientId.length>2048||/[^\x21-\x7e]/.test(value.clientId)||typeof value.clientSecret!=='string'||value.clientSecret.length>65536||/[^\x21-\x7e]/.test(value.clientSecret))throw new DocumentError('INVALID_REQUEST');const old=this.credentials();if(!value.clientSecret&&value.clientId!==old.client_id)throw new DocumentError('GOOGLE_CLIENT_SECRET_REQUIRED');const secret=value.clientSecret||old.client_secret;if(!secret)throw new DocumentError('GOOGLE_CLIENT_SECRET_REQUIRED');this.db.prepare('INSERT INTO google_application_settings VALUES(1,?,1) ON CONFLICT(id) DO UPDATE SET encrypted_config=excluded.encrypted_config,revision=google_application_settings.revision+1').run(this.secrets.encrypt({client_id:value.clientId,client_secret:secret}));return this.settings();}
}
