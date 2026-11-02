import {randomUUID,createHash} from 'node:crypto';
import {transaction,type Database} from '../database.ts';
import {SecretConfigs} from './secret-config.ts';
import {OAuthConfigs,type OAuthCredentials} from './oauth-config.ts';
import {ProviderError} from './adapter.ts';
export type OAuthRefreshLease={readonly requestId:string;credentials:()=>OAuthCredentials;check:()=>void;dispatch:()=>void;accept:(refreshToken?:string)=>void;release:()=>void;unknown:()=>void};
type Row={connection_id:string;connection_revision:number;request_id:string;owner_token:string;refresh_hash:string;state:'reserved'|'dispatched'|'complete'|'unknown';lease_until:number};
function invalid():never{throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
/** One durable refresh attempt per connection. No network calls or plaintext persistence. */
export class OAuthRefreshes{
 private db:Database;private configs:OAuthConfigs;private clock:()=>number;
 constructor(db:Database,configs:SecretConfigs,options:{clock?:()=>number}={}){this.db=db;this.configs=new OAuthConfigs(db,configs);this.clock=options.clock??Date.now;}
 private now(){const value=this.clock();if(!Number.isSafeInteger(value)||value<0||value>Number.MAX_SAFE_INTEGER-60000)invalid();return value;}
 private boundary<T>(action:()=>T):T{try{if(this.db.inTransaction)invalid();return action();}catch{return invalid();}}
 claim(connectionId:string,revision:number):OAuthRefreshLease|null{return this.boundary(()=>{
  const auth=this.configs.lease(connectionId,revision),requestId=randomUUID(),owner=randomUUID(),refreshHash=createHash('sha256').update(auth.credentials().refreshToken).digest('hex');
  const row=()=>this.db.prepare('SELECT * FROM provider_oauth_refreshes WHERE connection_id=?').get(connectionId) as Row|undefined;
  const result=transaction(this.db,()=>{
   auth.check();const now=this.now(),old=row();
   if(old&&(old.state==='reserved'?old.connection_revision===revision:old.refresh_hash===refreshHash)){
    if(old.state==='unknown')return 'unknown';
    if(old.state==='dispatched'&&old.lease_until<=now){this.db.prepare("UPDATE provider_oauth_refreshes SET state='unknown',updated_at=? WHERE connection_id=?").run(now,connectionId);return 'unknown';}
    if(old.state!=='complete'&&old.lease_until>now)return 'busy';
   }
   this.db.prepare("INSERT INTO provider_oauth_refreshes VALUES(?,?,?,?,?,'reserved',?,?,?) ON CONFLICT(connection_id) DO UPDATE SET connection_revision=excluded.connection_revision,refresh_hash=excluded.refresh_hash,request_id=excluded.request_id,owner_token=excluded.owner_token,state=excluded.state,lease_until=excluded.lease_until,created_at=excluded.created_at,updated_at=excluded.updated_at").run(connectionId,revision,refreshHash,requestId,owner,now+60000,now,now);return 'claimed';
  });
  if(result==='unknown')invalid();if(result==='busy')return null;
  const owned=(state:Row['state'],expired=false)=>{const current=row();if(!current||current.request_id!==requestId||current.owner_token!==owner||current.connection_revision!==revision||current.state!==state||!expired&&current.lease_until<=this.now())invalid();};
  const transition=(state:Row['state'])=>this.db.prepare('UPDATE provider_oauth_refreshes SET state=?,updated_at=? WHERE connection_id=? AND request_id=? AND owner_token=?').run(state,this.now(),connectionId,requestId,owner);
  return Object.freeze({requestId,credentials:()=>auth.credentials(),check:()=>auth.check(),
   dispatch:()=>this.boundary(()=>transaction(this.db,()=>{auth.check();owned('reserved');transition('dispatched');})),
   accept:(next?:string)=>this.boundary(()=>{auth.rotate(next??auth.credentials().refreshToken,()=>{owned('dispatched');transition('complete');});}),
   release:()=>this.boundary(()=>transaction(this.db,()=>{owned('reserved',true);transition('complete');})),
   unknown:()=>this.boundary(()=>transaction(this.db,()=>{owned('dispatched',true);transition('unknown');}))
  });
 });}
}
