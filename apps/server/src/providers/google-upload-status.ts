import {ProviderError,type ProviderCheck} from './adapter.ts';
import type {GoogleAuthorization} from './credential-vault.ts';
import {googleFileId} from './google-read-http.ts';
import {googleJson} from './google-json.ts';
type Input={reference:string;sessionUrl:string;size:number};
export type GoogleUploadState={state:'pending';received:number}|{state:'complete'}|{state:'expired'};
class AuthorityFailure{cause:unknown;constructor(cause:unknown){this.cause=cause;}}
const unavailable=()=>new ProviderError('PROVIDER_UNAVAILABLE');
function interrupt<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted){void work.catch(()=>{});return Promise.reject(unavailable());}
 return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(unavailable());};signal.addEventListener('abort',abort,{once:true});work.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});
}
export function googleUploadCapability(value:Input):string{
 googleFileId(value.reference);const invalid=()=>new ProviderError('PROVIDER_INVALID_REFERENCE');
 if(!Number.isSafeInteger(value.size)||value.size<0||value.size>4294967296||typeof value.sessionUrl!=='string'||value.sessionUrl.length>16384||/[^\x21-\x7e]/.test(value.sessionUrl))throw invalid();
 let url:URL;try{url=new URL(value.sessionUrl);}catch{throw invalid();}
 if(url.href!==value.sessionUrl||url.origin!=='https://www.googleapis.com'||url.username||url.password||url.hash||!['/upload/drive/v3/files','/upload/drive/v3/files/'+value.reference].includes(url.pathname))throw invalid();
 const keys=[...url.searchParams.keys()];if(keys.length!==2||new Set(keys).size!==2||url.searchParams.get('uploadType')!=='resumable'||!url.searchParams.has('upload_id'))throw invalid();
 const id=url.searchParams.get('upload_id')!;if(!id||id.length>8192||/[^\x21-\x7e]/.test(id))throw invalid();return url.href;
}
/** Private control-plane probe only. Completion still requires verified source readback.
 * Does not send file bytes, retry requests, follow redirects, retire or create sessions. */
export class GoogleUploadStatus{
 private auth:GoogleAuthorization;private request:typeof fetch;private timeoutMs:number;private closed=false;private active=new Map<AbortController,Promise<void>>();private draining:Promise<void>|undefined;
 constructor(auth:GoogleAuthorization,options:{fetch?:typeof fetch;timeoutMs?:number}={}){
  this.auth=auth;this.request=options.fetch??fetch;this.timeoutMs=options.timeoutMs??30000;if(!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>30000)throw new ProviderError('PROVIDER_CONFIG_CHANGED');
 }
 async query(value:Input,options:ProviderCheck):Promise<GoogleUploadState>{
  const input={...value},url=googleUploadCapability(input);if(this.closed||options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');if(this.active.size>=8)throw unavailable();
  const controller=new AbortController();let done!:()=>void;this.active.set(controller,new Promise<void>(r=>done=r));const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();const timer=setTimeout(abort,this.timeoutMs);
  const check=async()=>{if(controller.signal.aborted)throw unavailable();try{await interrupt(Promise.resolve().then(()=>options.check()),controller.signal);}catch(error){if(controller.signal.aborted)throw unavailable();throw new AuthorityFailure(error);}if(controller.signal.aborted)throw unavailable();};
  let response:Response|undefined;
  try{
   await check();const token=await interrupt(this.auth.access({signal:controller.signal,check}),controller.signal);await check();if(typeof token!=='string'||token.length<1||token.length>65536||/[^\x21-\x7e]/.test(token))throw new ProviderError('PROVIDER_CONFIG_CHANGED');
   const current=await interrupt<Response>(this.request(url,{method:'PUT',redirect:'manual',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal,headers:{authorization:'Bearer '+token,accept:'application/json','content-length':'0','content-range':'bytes */'+input.size}}).then(value=>{if(controller.signal.aborted){void value.body?.cancel().catch(()=>{});throw unavailable();}return value;}),controller.signal);response=current;await check();
   if(current.status===401){this.auth.invalidate(token);throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
   if(current.status===404)return {state:'expired'};
   if(current.status===403){
    const value=await googleJson(current,{signal:controller.signal,maxBytes:262144,check}),error=value.error as {errors?:unknown}|undefined,details=error&&typeof error==='object'&&Array.isArray(error.errors)?error.errors.slice(0,64):[];
    if(details.some(item=>item&&typeof item==='object'&&['rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded','downloadQuotaExceeded'].includes((item as {reason:string}).reason)))throw unavailable();throw new ProviderError('ACCESS_DENIED');
   }
   if(current.status===412)throw new ProviderError('PROVIDER_CONFLICT');
   if(current.status===308){
    const location=current.headers.get('location');if(location!==null&&location!==url)throw unavailable();const range=current.headers.get('range');let received=0;
    if(range!==null){if(!/^bytes=0-(0|[1-9][0-9]{0,9})$/.test(range))throw unavailable();received=Number(range.slice(8))+1;if(!Number.isSafeInteger(received)||received>input.size)throw unavailable();}
    await check();return {state:'pending',received};
   }
   if(current.status!==200&&current.status!==201)throw unavailable();
   const file=await googleJson(current,{signal:controller.signal,maxBytes:262144,check});if(file.id!==input.reference)throw unavailable();await check();return {state:'complete'};
  }catch(error){if(this.closed||options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');if(error instanceof AuthorityFailure){let cause=error.cause;while(cause instanceof AuthorityFailure)cause=cause.cause;throw cause;}if(error instanceof ProviderError)throw error;throw unavailable();}
  finally{void response?.body?.cancel().catch(()=>{});clearTimeout(timer);options.signal?.removeEventListener('abort',abort);controller.abort();this.active.delete(controller);done();}
 }
 close():Promise<void>{if(this.draining)return this.draining;this.closed=true;const pending=[...this.active.values()];for(const controller of this.active.keys())controller.abort();this.draining=Promise.all(pending).then(()=>{});return this.draining;}
}
