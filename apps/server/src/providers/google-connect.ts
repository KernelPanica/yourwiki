import {readTransaction,type Database} from '../database.ts';
import {authenticateSession} from '../auth/sessions.ts';
import {DocumentError} from '../document-errors.ts';
import {ProviderError,type ProviderCheck} from './adapter.ts';
import {SecretConfigs} from './secret-config.ts';
import {GoogleConnectStates,type GoogleConnectResult} from './google-connect-state.ts';
import {GoogleCodeExchange} from './google-code-exchange.ts';
import {verifyGoogleAccount} from './google-account.ts';
type Actor={sessionToken:string;csrf:string};
/** Explicit administrative connect flow only. No page-open or source-file IO. */
export class GoogleConnect{
 private db:Database;private configs:SecretConfigs;private states:GoogleConnectStates;private exchange:GoogleCodeExchange;private request:typeof fetch;private origin:string;private closed=false;private lifetime=new AbortController();private active=new Set<Promise<GoogleConnectResult>>();private draining:Promise<void>|undefined;
 constructor(db:Database,configs:SecretConfigs,publicUrl:string,options:{fetch?:typeof fetch;clock?:()=>number}={}){this.db=db;this.configs=configs;this.request=options.fetch??fetch;this.states=new GoogleConnectStates(db,configs,publicUrl,{clock:options.clock});this.origin=new URL(publicUrl).origin;this.exchange=new GoogleCodeExchange({fetch:this.request});}
 belongsToDatabase(db:Database,publicUrl?:string){return this.db===db&&!this.closed&&(publicUrl===undefined||new URL(publicUrl).origin===this.origin);}
 private live(){if(this.closed)throw new ProviderError('PROVIDER_CANCELLED');}
 begin(input:Actor&{connectionId:string;baseRevision:number}){this.live();return this.states.begin(input);}
 result(input:Actor&{state:string}){this.live();return this.states.result(input);}
 connections(sessionToken:string,after=''){
  this.live();return readTransaction(this.db,()=>{const session=authenticateSession(this.db,sessionToken);if(!session)throw new DocumentError('SESSION_REQUIRED');if(session.adminRole!=='giga')throw new DocumentError('ACCESS_DENIED');if(typeof after!=='string'||after!==''&&!/^[A-Za-z0-9_.:-]{1,128}$/.test(after))throw new DocumentError('INVALID_REQUEST');
   const rows=this.db.prepare("SELECT c.id,c.label,c.revision,c.enabled,c.encrypted_config,m.path FROM provider_connections c JOIN provider_mounts m ON m.connection_id=c.id WHERE c.provider='google' AND c.id>? ORDER BY c.id LIMIT 51").all(after) as {id:string;label:string;revision:number;enabled:number;encrypted_config:string;path:string}[];
   const items=rows.slice(0,50).map(row=>{let configurationReady=false,authorizationStored=false;try{const c=this.configs.decrypt(row.encrypted_config),visible=(v:unknown,max:number)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[^\x21-\x7e]/.test(v);configurationReady=typeof c.root==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(c.root)&&visible(c.client_id,2048)&&visible(c.client_secret,65536);authorizationStored=visible(c.refresh_token,65536);}catch{/* Only safe setup state, never encrypted/plain configuration. */}return {id:row.id,label:row.label,path:row.path,revision:row.revision,enabled:row.enabled===1,configurationReady,authorizationStored};});return {items,nextCursor:rows.length>50?items.at(-1)!.id:null};
  });
 }
 async complete(value:Actor&{state:string;code:string},options:ProviderCheck={check(){}}):Promise<GoogleConnectResult>{
  this.live();if(options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');const input={...value},result=this.states.result(input);if(result)return result;if(typeof input.code!=='string'||input.code.length<1||input.code.length>8192||/[^\x21-\x7e]/.test(input.code))throw new DocumentError('INVALID_REQUEST');if(this.active.size>=4)throw new ProviderError('PROVIDER_UNAVAILABLE');
  const signal=options.signal?AbortSignal.any([options.signal,this.lifetime.signal]):this.lifetime.signal;
  let work!:Promise<GoogleConnectResult>;work=(async()=>{const lease=this.states.claim(input),issued=await this.exchange.exchange(lease,input.code,{check:options.check,signal}),proof=await verifyGoogleAccount(this.db,this.configs,lease,issued,{check:options.check,signal,fetch:this.request});if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');return this.states.publish(lease,issued,proof);})().finally(()=>this.active.delete(work));this.active.add(work);return work;
 }
 close():Promise<void>{if(this.draining)return this.draining;this.closed=true;this.lifetime.abort();this.draining=Promise.allSettled([this.exchange.close(),...this.active]).then(()=>{});return this.draining;}
}
