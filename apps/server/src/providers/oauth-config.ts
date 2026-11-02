import {transaction,type Database} from '../database.ts';
import {SecretConfigs} from './secret-config.ts';
import {ProviderError} from './adapter.ts';
export type OAuthCredentials={clientId:string;clientSecret:string;refreshToken:string};
export type OAuthCredentialLease={credentials:()=>OAuthCredentials;check:()=>void;rotate:(refreshToken:string)=>void};
type Row={provider:string;revision:number;enabled:number;encrypted_config:string};
function invalid():never{throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
function credential(value:unknown):value is string{return typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=65536&&!/[\x00-\x20\x7f]/.test(value)&&Buffer.from(value).toString('utf8')===value;}
/** Internal worker capability only. Never register as a credential/config HTTP reader. */
export class OAuthConfigs{
 private db:Database;private configs:SecretConfigs;
 constructor(db:Database,configs:SecretConfigs){this.db=db;this.configs=configs;}
 lease(connectionId:string,revision:number):OAuthCredentialLease{
  if(typeof connectionId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(connectionId)||!Number.isSafeInteger(revision)||revision<1)invalid();
  const row=():Row|undefined=>{try{return this.db.prepare('SELECT provider,revision,enabled,encrypted_config FROM provider_connections WHERE id=?').get(connectionId) as Row|undefined;}catch{return invalid();}};
  const initial=row();if(!initial||initial.provider!=='google'||initial.revision!==revision||initial.enabled!==1)invalid();
  let cipher=initial.encrypted_config,config:Record<string,unknown>;
  try{config=this.configs.decrypt(cipher);}catch{return invalid();}
  if(config.provider!==undefined&&config.provider!=='google'||!credential(config.client_id)||!credential(config.client_secret)||!credential(config.refresh_token))invalid();
  const clientId=config.client_id as string,clientSecret=config.client_secret as string;let refreshToken=config.refresh_token as string;
  const check=()=>{const current=row();if(!current||current.provider!=='google'||current.revision!==revision||current.enabled!==1||current.encrypted_config!==cipher)invalid();};
  return {
   credentials:()=>{check();return {clientId,clientSecret,refreshToken};},
   check,
   rotate:(next:string)=>{
    if(!credential(next))invalid();
    let changed:string|undefined;
    try{transaction(this.db,()=>{check();if(next===refreshToken)return;changed=this.configs.encrypt({...config,refresh_token:next});const result=this.db.prepare('UPDATE provider_connections SET encrypted_config=? WHERE id=? AND provider=\'google\' AND enabled=1 AND revision=? AND encrypted_config=?').run(changed,connectionId,revision,cipher);if(result.changes!==1)invalid();});}
    catch(error){if(error instanceof ProviderError)throw error;return invalid();}
    // Publish new in-memory credentials only after durable transaction success.
    if(changed!==undefined){cipher=changed;refreshToken=next;config={...config,refresh_token:next};}
   }
  };
 }
}
