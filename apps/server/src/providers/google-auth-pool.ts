import type {Database} from '../database.ts';
import {SecretConfigs} from './secret-config.ts';
import {OAuthRefreshes} from './oauth-refresh.ts';
import {GoogleTokens} from './google-tokens.ts';
import {ProviderError,type ProviderCheck} from './adapter.ts';
export type GoogleAuthPoolOptions={limit?:number;fetch?:typeof fetch;clock?:()=>number;timeoutMs?:number};
type Entry={revision:number;tokens:GoogleTokens;uses:number};
/** Worker-owned bounded LRU. Adapters borrow authority, never own the shared client's close(). */
export class GoogleAuthPool{
 private database:Database;
 belongsToDatabase(db:Database){return this.database===db&&!this.closed;}
 private refreshes:OAuthRefreshes;private options:GoogleAuthPoolOptions;private limit:number;private entries=new Map<string,Entry>();private retiring=new Set<Promise<void>>();private closed=false;private draining:Promise<void>|undefined;
 constructor(db:Database,configs:SecretConfigs,options:GoogleAuthPoolOptions={}){this.database=db;this.options={...options};this.limit=options.limit??32;if(!Number.isSafeInteger(this.limit)||this.limit<1||this.limit>256)throw new ProviderError('PROVIDER_CONFIG_CHANGED');this.refreshes=new OAuthRefreshes(db,configs);}
 private retire(entry:Entry){const pending=entry.tokens.inFlight,end=entry.tokens.close();if(pending){this.retiring.add(end);void end.then(()=>this.retiring.delete(end));}}
 private entry(id:string,revision:number){
  if(this.closed)throw new ProviderError('PROVIDER_CANCELLED');const old=this.entries.get(id);
  if(old?.revision===revision){this.entries.delete(id);this.entries.set(id,old);return old;}
  if(old){this.entries.delete(id);this.retire(old);}
  if(this.entries.size+this.retiring.size>=this.limit){const idle=[...this.entries].find(([,entry])=>entry.uses===0&&!entry.tokens.inFlight);if(!idle)throw new ProviderError('PROVIDER_UNAVAILABLE');this.entries.delete(idle[0]);this.retire(idle[1]);}
  if(this.entries.size+this.retiring.size>=this.limit)throw new ProviderError('PROVIDER_UNAVAILABLE');
  const entry:Entry={revision,uses:0,tokens:new GoogleTokens({connectionId:id,revision,refreshes:this.refreshes,fetch:this.options.fetch,clock:this.options.clock,timeoutMs:this.options.timeoutMs})};this.entries.set(id,entry);return entry;
 }
 async access(id:string,revision:number,options:ProviderCheck){const entry=this.entry(id,revision);entry.uses++;try{return await entry.tokens.access(options);}finally{entry.uses--;}}
 invalidate(id:string,revision:number,token:string){if(this.closed)throw new ProviderError('PROVIDER_CANCELLED');const entry=this.entries.get(id);if(entry?.revision===revision)entry.tokens.invalidate(token);}
 close():Promise<void>{if(this.draining)return this.draining;this.closed=true;for(const entry of this.entries.values())this.retire(entry);this.entries.clear();this.draining=Promise.all([...this.retiring]).then(()=>{});return this.draining;}
}
