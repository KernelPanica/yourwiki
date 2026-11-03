import {googleJson} from './google-json.ts';
import type {GoogleAuthorization} from './credential-vault.ts';
import {ProviderError,type ProviderCheck} from './adapter.ts';
type Options={fetch?:typeof fetch;timeoutMs?:number};
class AuthorityFailure{cause:unknown;constructor(cause:unknown){this.cause=cause;}}
function unavailable(){return new ProviderError('PROVIDER_UNAVAILABLE');}
function interrupt<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted){void work.catch(()=>{});return Promise.reject(unavailable());}
 return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(unavailable());};signal.addEventListener('abort',abort,{once:true});work.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});
}
export function googleFileId(id:unknown):string{if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(id))throw new ProviderError('PROVIDER_INVALID_REFERENCE');return id;}
/** Fixed-origin metadata/permissions GETs only. Source bytes and provider writes use separate protocols. */
export class GoogleReadHttp{
 private auth:GoogleAuthorization;private request:typeof fetch;private timeoutMs:number;private closed=false;private active=new Map<AbortController,Promise<void>>();private draining:Promise<void>|undefined;
 constructor(auth:GoogleAuthorization,options:Options={}){this.auth=auth;this.request=options.fetch??fetch;this.timeoutMs=options.timeoutMs??30000;if(!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>30000)throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
 async file(id:string,fields:string,options:ProviderCheck):Promise<Record<string,unknown>>{
  googleFileId(id);if(typeof fields!=='string'||fields.length<1||fields.length>8192||/[^\x20-\x7e]/.test(fields))throw new ProviderError('PROVIDER_INVALID_REFERENCE');return this.read('files/'+id,new URLSearchParams({fields}),options);
 }
 async about(options:ProviderCheck):Promise<Record<string,unknown>>{return this.read('about',new URLSearchParams({fields:'user(permissionId,me)'}),options);}
 async permissions(id:string,options:ProviderCheck,pageToken?:string):Promise<Record<string,unknown>>{
  googleFileId(id);if(pageToken!==undefined&&(typeof pageToken!=='string'||pageToken.length<1||pageToken.length>16384||/[\x00-\x20\x7f]/.test(pageToken)))throw new ProviderError('PROVIDER_INVALID_REFERENCE');const query=new URLSearchParams({fields:'permissions(id,type,emailAddress,role,permissionDetails),nextPageToken',pageSize:'100'});if(pageToken!==undefined)query.set('pageToken',pageToken);return this.read('files/'+id+'/permissions',query,options);
 }
 private async read(path:string,query:URLSearchParams,options:ProviderCheck):Promise<Record<string,unknown>>{
  if(this.closed||options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');if(this.active.size>=8)throw unavailable();
  const controller=new AbortController();let done!:()=>void;this.active.set(controller,new Promise<void>(resolve=>done=resolve));const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();const timer=setTimeout(abort,this.timeoutMs);
  const check=async()=>{if(controller.signal.aborted)throw unavailable();try{await interrupt(Promise.resolve().then(()=>options.check()),controller.signal);}catch(error){if(controller.signal.aborted)throw unavailable();throw new AuthorityFailure(error);}if(controller.signal.aborted)throw unavailable();};
  try{for(let attempt=0;attempt<2;attempt++){
    await check();const token=await interrupt(this.auth.access({signal:controller.signal,check}),controller.signal);await check();if(typeof token!=='string'||token.length<1||token.length>65536||/[^\x21-\x7e]/.test(token))throw new ProviderError('PROVIDER_CONFIG_CHANGED');
    const response=await interrupt(this.request('https://www.googleapis.com/drive/v3/'+path+'?'+query.toString(),{method:'GET',redirect:'manual',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json',authorization:'Bearer '+token}}).then(response=>{if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw unavailable();}return response;}),controller.signal);
    // Even an early authorization failure must cancel the body without leaking its JSON.
    try{await check();}catch(error){void response.body?.cancel().catch(()=>{});throw error;}
    if(response.status===401){void response.body?.cancel().catch(()=>{});this.auth.invalidate(token);if(attempt===0)continue;throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
    if(response.status!==200&&response.status!==403){void response.body?.cancel().catch(()=>{});if(response.status===404)throw new ProviderError('PROVIDER_SOURCE_CHANGED');if(response.status===412)throw new ProviderError('PROVIDER_CONFLICT');if(response.status===400)throw new ProviderError('PROVIDER_CONFIG_CHANGED');throw unavailable();}
    const value=await googleJson(response,{signal:controller.signal,maxBytes:262144,check});
    if(response.status===403){const error=value.error as {errors?:unknown}|undefined,details=error&&typeof error==='object'&&Array.isArray(error.errors)?error.errors.slice(0,64):[];if(details.some(item=>item&&typeof item==='object'&&['rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded','downloadQuotaExceeded'].includes((item as any).reason)))throw unavailable();throw new ProviderError('ACCESS_DENIED');}
    await check();return value;
   }
   throw unavailable();
  }catch(error){if(this.closed||options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');if(error instanceof AuthorityFailure){let cause=error.cause;while(cause instanceof AuthorityFailure)cause=cause.cause;throw cause;}if(error instanceof ProviderError)throw error;throw unavailable();}
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);controller.abort();this.active.delete(controller);done();}
 }
 close():Promise<void>{if(this.draining)return this.draining;this.closed=true;const pending=[...this.active.values()];for(const controller of this.active.keys())controller.abort();this.draining=Promise.all(pending).then(()=>{});return this.draining;}
}
