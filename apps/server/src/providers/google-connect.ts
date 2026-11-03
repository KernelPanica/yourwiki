import type {Database} from '../database.ts';
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
 async complete(value:Actor&{state:string;code:string},options:ProviderCheck={check(){}}):Promise<GoogleConnectResult>{
  this.live();if(options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');const input={...value},result=this.states.result(input);if(result)return result;if(typeof input.code!=='string'||input.code.length<1||input.code.length>8192||/[^\x21-\x7e]/.test(input.code))throw new DocumentError('INVALID_REQUEST');if(this.active.size>=4)throw new ProviderError('PROVIDER_UNAVAILABLE');
  const signal=options.signal?AbortSignal.any([options.signal,this.lifetime.signal]):this.lifetime.signal;
  let work!:Promise<GoogleConnectResult>;work=(async()=>{const lease=this.states.claim(input),issued=await this.exchange.exchange(lease,input.code,{check:options.check,signal}),proof=await verifyGoogleAccount(this.db,this.configs,lease,issued,{check:options.check,signal,fetch:this.request});if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');return this.states.publish(lease,issued,proof);})().finally(()=>this.active.delete(work));this.active.add(work);return work;
 }
 close():Promise<void>{if(this.draining)return this.draining;this.closed=true;this.lifetime.abort();this.draining=Promise.allSettled([this.exchange.close(),...this.active]).then(()=>{});return this.draining;}
}
