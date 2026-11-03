import {setImmediate as yieldTurn} from 'node:timers/promises';
import {ProviderError,type ProviderCheck} from './adapter.ts';
import type {GoogleAuthorization} from './credential-vault.ts';
import {googleFileId} from './google-read-http.ts';
import {googleJson} from './google-json.ts';
export type GoogleNativeKind='document'|'presentation';
export type GoogleNativeData=Readonly<{kind:GoogleNativeKind;reference:string;revision:string;data:Readonly<Record<string,unknown>>}>;
type Options={fetch?:typeof fetch;timeoutMs?:number;maxBytes?:number};
class AuthorityFailure{cause:unknown;constructor(cause:unknown){this.cause=cause;}}
const unavailable=()=>new ProviderError('PROVIDER_UNAVAILABLE');
const validRevision=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=4096&&value!=='*'&&!/[^\x21-\x7e]/.test(value);
function interrupt<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{if(signal.aborted){void work.catch(()=>{});return Promise.reject(unavailable());}return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(unavailable());};signal.addEventListener('abort',abort,{once:true});work.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});}
/** Native document representation, distinct from small control-plane googleJson.
 * Bound bytes/JSON structure before parse; never truncate a document into a successful snapshot. */
async function nativeJson(response:Response,maxBytes:number,options:ProviderCheck&{signal:AbortSignal}):Promise<Record<string,unknown>>{
 const length=response.headers.get('content-length');if(length!==null&&(!/^(0|[1-9][0-9]{0,8})$/.test(length)||Number(length)>maxBytes)||!response.body)throw unavailable();
 const reader=response.body.getReader(),bytes=new Uint8Array(maxBytes);let size=0,empty=0,inString=false,escaped=false,depth=0,tokens=0;
 const cancel=()=>{void reader.cancel().catch(()=>{});};options.signal.addEventListener('abort',cancel,{once:true});
 try{for(;;){await options.check();const part=await interrupt(reader.read(),options.signal);await options.check();if(part.done)break;if(size+part.value.byteLength>maxBytes||!part.value.byteLength&&++empty>65536)throw unavailable();
   for(const byte of part.value){if(inString){if(escaped)escaped=false;else if(byte===92)escaped=true;else if(byte===34)inString=false;}else if(byte===34)inString=true;else if(byte===123||byte===91){if(++depth>128||++tokens>500000)throw unavailable();}else if(byte===125||byte===93){if(--depth<0)throw unavailable();}else if((byte===44||byte===58)&&++tokens>500000)throw unavailable();}
   bytes.set(part.value,size);size+=part.value.byteLength;
  }
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)));if(!value||typeof value!=='object'||Array.isArray(value))throw unavailable();
  const pending:{value:unknown;depth:number}[]=[{value,depth:0}];let nodes=0;
  while(pending.length){const next=pending.pop()!;if(++nodes>250000||next.depth>128)throw unavailable();if(typeof next.value==='number'&&(!Number.isFinite(next.value)||Number.isInteger(next.value)&&!Number.isSafeInteger(next.value)))throw unavailable();if(typeof next.value==='string'&&Buffer.from(next.value).toString('utf8')!==next.value)throw unavailable();
   if(next.value&&typeof next.value==='object'){Object.freeze(next.value);const children=Object.values(next.value);if(children.length>250000-nodes)throw unavailable();for(const child of children)pending.push({value:child,depth:next.depth+1});}
   if(nodes%4096===0){await yieldTurn();await options.check();}
  }
  await options.check();return value as Record<string,unknown>;
 }finally{options.signal.removeEventListener('abort',cancel);cancel();try{reader.releaseLock();}catch{/* Cancellation owns pending stream cleanup. */}}
}
function checkedData(kind:GoogleNativeKind,reference:string,data:Record<string,unknown>):GoogleNativeData{
 if(data[kind==='document'?'documentId':'presentationId']!==reference||!validRevision(data.revisionId))throw new ProviderError('PROVIDER_SOURCE_CHANGED');
 if(kind==='document'){
  if(!Array.isArray(data.tabs)||!data.tabs.length)throw new ProviderError('PROVIDER_SOURCE_CHANGED');const pending=[...data.tabs],ids=new Set<string>();
  while(pending.length){const tab=pending.pop(),properties=tab&&typeof tab==='object'?(tab as Record<string,unknown>).tabProperties:null,id=properties&&typeof properties==='object'?(properties as Record<string,unknown>).tabId:null;if(typeof id!=='string'||!id||id.length>256||/[^\x21-\x7e]/.test(id)||ids.has(id)||ids.size>=4096)throw new ProviderError('PROVIDER_SOURCE_CHANGED');ids.add(id);const children=(tab as Record<string,unknown>).childTabs;if(children!==undefined){if(!Array.isArray(children))throw new ProviderError('PROVIDER_SOURCE_CHANGED');pending.push(...children);}}
 }else if(data.slides!==undefined&&!Array.isArray(data.slides))throw new ProviderError('PROVIDER_SOURCE_CHANGED');
 return Object.freeze({kind,reference,revision:data.revisionId,data});
}
/** Private structured native read only: all Docs tabs, no projection/suggestion acceptance. */
export class GoogleNativeRead{
 private auth:GoogleAuthorization;private request:typeof fetch;private timeoutMs:number;private maxBytes:number;private closed=false;private active=new Map<AbortController,Promise<void>>();private draining:Promise<void>|undefined;
 constructor(auth:GoogleAuthorization,options:Options={}){this.auth=auth;this.request=options.fetch??fetch;this.timeoutMs=options.timeoutMs??30000;this.maxBytes=options.maxBytes??16*1024**2;if(!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>30000||!Number.isSafeInteger(this.maxBytes)||this.maxBytes<1024||this.maxBytes>64*1024**2)throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
 async read(kind:GoogleNativeKind,reference:string,options:ProviderCheck):Promise<GoogleNativeData>{
  if(!['document','presentation'].includes(kind))throw new ProviderError('PROVIDER_INVALID_REFERENCE');googleFileId(reference);const parent=options.signal,authority=options.check;if(this.closed||parent?.aborted)throw new ProviderError('PROVIDER_CANCELLED');if(this.active.size>=4)throw unavailable();
  const controller=new AbortController();let done!:()=>void;this.active.set(controller,new Promise<void>(resolve=>done=resolve));const abort=()=>controller.abort();parent?.addEventListener('abort',abort,{once:true});if(parent?.aborted)abort();const timer=setTimeout(abort,this.timeoutMs);let response:Response|undefined;
  const check=async()=>{if(controller.signal.aborted)throw unavailable();try{await interrupt(Promise.resolve().then(()=>authority()),controller.signal);}catch(error){if(controller.signal.aborted)throw unavailable();throw new AuthorityFailure(error);}if(controller.signal.aborted)throw unavailable();};
  try{for(let attempt=0;attempt<2;attempt++){
    await check();const token=await interrupt(this.auth.access({signal:controller.signal,check}),controller.signal);await check();if(typeof token!=='string'||token.length<1||token.length>65536||/[^\x21-\x7e]/.test(token))throw new ProviderError('PROVIDER_CONFIG_CHANGED');
    const url=kind==='document'?'https://docs.googleapis.com/v1/documents/'+reference+'?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE':'https://slides.googleapis.com/v1/presentations/'+reference;
    const current=await interrupt<Response>(this.request(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{authorization:'Bearer '+token,accept:'application/json'}}).then(value=>{if(controller.signal.aborted){void value.body?.cancel().catch(()=>{});throw unavailable();}return value;}),controller.signal);response=current;await check();
    if(current.status===401){void current.body?.cancel().catch(()=>{});this.auth.invalidate(token);if(attempt===0)continue;throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
    if(current.status===404)throw new ProviderError('PROVIDER_SOURCE_CHANGED');if(current.status===403){const value=await googleJson(current,{signal:controller.signal,maxBytes:65536,check}),error=value.error as {errors?:unknown}|undefined,details=error&&typeof error==='object'&&Array.isArray(error.errors)?error.errors.slice(0,64):[];if(details.some(item=>item&&typeof item==='object'&&['rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded'].includes((item as {reason:string}).reason)))throw unavailable();throw new ProviderError('ACCESS_DENIED');}
    if(current.status!==200)throw unavailable();const data=await nativeJson(current,this.maxBytes,{signal:controller.signal,check});await check();return checkedData(kind,reference,data);
   }throw unavailable();
  }catch(error){if(this.closed||parent?.aborted)throw new ProviderError('PROVIDER_CANCELLED');if(error instanceof AuthorityFailure){let cause=error.cause;while(cause instanceof AuthorityFailure)cause=cause.cause;throw cause;}if(error instanceof ProviderError)throw error;throw unavailable();}
  finally{void response?.body?.cancel().catch(()=>{});clearTimeout(timer);parent?.removeEventListener('abort',abort);controller.abort();this.active.delete(controller);done();}
 }
 close():Promise<void>{if(this.draining)return this.draining;this.closed=true;const pending=[...this.active.values()];for(const controller of this.active.keys())controller.abort();this.draining=Promise.all(pending).then(()=>{});return this.draining;}
}
