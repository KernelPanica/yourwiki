import {OAuthRefreshes,type OAuthRefreshLease} from './oauth-refresh.ts';
import {ProviderError,type ProviderCheck} from './adapter.ts';
type Options={connectionId:string;revision:number;refreshes:OAuthRefreshes;clock?:()=>number;fetch?:typeof fetch;timeoutMs?:number};
const endpoint='https://oauth2.googleapis.com/token';
const knownErrors=['invalid_request','invalid_client','invalid_grant','unauthorized_client','unsupported_grant_type','invalid_scope','server_error','temporarily_unavailable'];
const failure=()=>new ProviderError('PROVIDER_UNAVAILABLE'),cancelled=()=>new ProviderError('PROVIDER_CANCELLED');
/** A waiter's abort only cancels that waiter; the shared refresh may still persist issued credentials. */
function wait<T>(work:Promise<T>,signal?:AbortSignal):Promise<T>{
 if(!signal)return work;if(signal.aborted){void work.catch(()=>{});return Promise.reject(cancelled());}
 return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(cancelled());};signal.addEventListener('abort',abort,{once:true});work.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});
}
async function json(response:Response,signal:AbortSignal):Promise<Record<string,unknown>>{
 if(!response.body)throw failure();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
 const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
 try{for(;;){if(signal.aborted)throw failure();const part=await reader.read();if(signal.aborted)throw failure();if(part.done)break;if(size+part.value.byteLength>65536||parts.length>=65536)throw failure();size+=part.value.byteLength;parts.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw failure();return value as Record<string,unknown>;
 }finally{signal.removeEventListener('abort',cancel);cancel();try{reader.releaseLock();}catch{/* A pending cancelled native read owns its cleanup. */}}
}
/** Worker-only bearer cache. No page request, write retry loop or configurable token URL. */
export class GoogleTokens{
 private options:Options;private request:typeof fetch;private clock:()=>number;private timeoutMs:number;private closed=false;private lifetime=new AbortController();private pending:Promise<string>|null=null;private active:AbortController|undefined;private token:string|null=null;private issuedAt=0;private expiresAt=0;private credentialCheck:(()=>void)|undefined;
 constructor(options:Options){this.options={...options};this.request=options.fetch??fetch;this.clock=options.clock??(()=>performance.now());this.timeoutMs=options.timeoutMs??30000;if(!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>30000)throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
 private now(){const value=this.clock();if(!Number.isFinite(value)||value<0||value>Number.MAX_SAFE_INTEGER)throw failure();return value;}
 private async guard(options:ProviderCheck){if(this.closed||options.signal?.aborted)throw cancelled();const signal=options.signal?AbortSignal.any([options.signal,this.lifetime.signal]):this.lifetime.signal;await wait(Promise.resolve().then(()=>options.check()),signal);if(this.closed||options.signal?.aborted)throw cancelled();}
 async access(options:ProviderCheck):Promise<string>{
  await this.guard(options);let token:string;
  const now=this.now();if(this.token&&now>=this.issuedAt&&now<this.expiresAt){this.credentialCheck?.();token=this.token;}
  else{if(!this.pending)this.pending=this.refresh().finally(()=>{this.pending=null;});token=await wait(this.pending,options.signal);}
  await this.guard(options);this.credentialCheck?.();if(token!==this.token||this.now()<this.issuedAt||this.now()>=this.expiresAt)throw failure();return token;
 }
 private async refresh():Promise<string>{
  const started=this.now();let lease:OAuthRefreshLease|null=null,dispatched=false,resolved=false;const controller=new AbortController();this.active=controller;const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
  try{
   lease=this.options.refreshes.claim(this.options.connectionId,this.options.revision);if(!lease)throw failure();const credentials=lease.credentials();lease.dispatch();dispatched=true;
   const result=await wait((async()=>{
    const response=await this.request(endpoint,{method:'POST',redirect:'manual',cache:'no-store',signal:controller.signal,headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:credentials.clientId,client_secret:credentials.clientSecret,refresh_token:credentials.refreshToken})});
    if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw failure();}
    if(response.status>=300&&response.status<400){void response.body?.cancel().catch(()=>{});throw failure();}
    return {status:response.status,body:await json(response,controller.signal)};
   })(),controller.signal);
   if(result.status!==200){
    if(result.status>=400&&result.status<600&&typeof result.body.error==='string'&&knownErrors.includes(result.body.error)&&!Object.hasOwn(result.body,'access_token')&&!Object.hasOwn(result.body,'refresh_token')){
     // A complete OAuth error response proves no token was issued. Complete the request, not a new credential.
     lease.accept();resolved=true;throw new ProviderError(['server_error','temporarily_unavailable'].includes(result.body.error)?'PROVIDER_UNAVAILABLE':'PROVIDER_CONFIG_CHANGED');
    }
    throw failure();
   }
   const value=result.body;
   // Preserve a rotated refresh token even if the accompanying access-token fields are unusable.
   if(value.refresh_token!==undefined&&typeof value.refresh_token!=='string')throw failure();lease.accept(value.refresh_token as string|undefined);resolved=true;
   if(typeof value.access_token!=='string'||value.access_token.length<1||value.access_token.length>65536||/[^\x21-\x7e]/.test(value.access_token)||typeof value.token_type!=='string'||value.token_type.toLowerCase()!=='bearer'||!Number.isSafeInteger(value.expires_in)||Number(value.expires_in)<=0)throw failure();
   const lifetime=Number(value.expires_in)*1000,end=started+lifetime-Math.min(60000,lifetime*.1);if(!Number.isFinite(end)||end>Number.MAX_SAFE_INTEGER||this.now()<started||this.now()>=end)throw failure();
   if(this.closed)throw cancelled();this.token=value.access_token;this.issuedAt=started;this.expiresAt=end;this.credentialCheck=lease.check;return this.token;
  }catch(error){if(lease&&!resolved)try{if(dispatched)lease.unknown();else lease.release();}catch{/* A newer explicit credential context fences this old owner. */}
   if(this.closed)throw cancelled();if(error instanceof ProviderError&&['PROVIDER_CONFIG_CHANGED','PROVIDER_UNAVAILABLE'].includes(error.code))throw error;throw failure();
  }finally{clearTimeout(timer);if(this.active===controller)this.active=undefined;}
 }
 get inFlight(){return this.pending!==null;}
 invalidate(accessToken:string){if(this.token===accessToken){this.token=null;this.expiresAt=0;}}
 close():Promise<void>{if(!this.closed){this.closed=true;this.token=null;this.expiresAt=0;this.credentialCheck=undefined;this.lifetime.abort();this.active?.abort();}return this.pending?this.pending.then(()=>{},()=>{}):Promise.resolve();}
}
