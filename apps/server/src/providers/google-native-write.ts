import {ProviderError,safeProviderError,type ProviderCheck} from './adapter.ts';
import type {GoogleAuthorization} from './credential-vault.ts';
import {googleFileId} from './google-read-http.ts';
import {googleJson} from './google-json.ts';
export type GoogleNativeUpdate={kind:'document'|'presentation';reference:string;requiredRevisionId:string;requests:readonly Record<string,unknown>[]};
const invalid=()=>new ProviderError('PROVIDER_INVALID_REFERENCE');
const revision=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=4096&&value!=='*'&&!/[^\x21-\x7e]/.test(value);
function fields(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.getOwnPropertySymbols(value).length)throw invalid();const result=Object.create(null),names=Object.getOwnPropertyNames(value);if(names.length>50000)throw invalid();
 for(const key of names){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor?.enumerable||!('value' in descriptor))throw invalid();Object.defineProperty(result,key,{value:descriptor.value,enumerable:true});}return result;
}
/** Snapshot data descriptors before any asynchronous work. No toJSON/getters or URL overrides. */
export function encodeGoogleNativeUpdate(input:unknown){
 const value=fields(input);if(Object.keys(value).length!==4||typeof value.kind!=='string'||!['document','presentation'].includes(value.kind)||!revision(value.requiredRevisionId)||!Array.isArray(value.requests)||value.requests.length<1||value.requests.length>1000)throw invalid();const reference=googleFileId(value.reference);let bytes=0,nodes=0;const ancestors=new Set<object>();
 const charge=(size:number)=>{bytes+=size;if(bytes>1048576)throw invalid();};
 const text=(value:string)=>{if(value.length>1048576||Buffer.from(value).toString('utf8')!==value)throw invalid();const encoded=JSON.stringify(value);charge(Buffer.byteLength(encoded));return encoded;};
 function encode(value:unknown,depth=0):string{
  if(++nodes>50000||depth>40)throw invalid();if(value===null){charge(4);return 'null';}if(typeof value==='string')return text(value);if(typeof value==='boolean'){const out=String(value);charge(out.length);return out;}if(typeof value==='number'){if(!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value))throw invalid();const out=JSON.stringify(value);charge(out.length);return out;}if(typeof value!=='object'||ancestors.has(value))throw invalid();ancestors.add(value);
  try{if(Array.isArray(value)){if(Object.getPrototypeOf(value)!==Array.prototype||Object.getOwnPropertySymbols(value).length||Object.getOwnPropertyNames(value).length!==value.length+1||value.length>50000)throw invalid();charge(2+Math.max(0,value.length-1));const parts:string[]=[];for(let index=0;index<value.length;index++){const descriptor=Object.getOwnPropertyDescriptor(value,String(index));if(!descriptor?.enumerable||!('value' in descriptor))throw invalid();parts.push(encode(descriptor.value,depth+1));}return '['+parts.join(',')+']';}
   const object=fields(value),keys=Object.keys(object);charge(2+Math.max(0,keys.length-1));return '{'+keys.map(key=>{const name=text(key);charge(1);return name+':'+encode(object[key],depth+1);}).join(',')+'}';
  }finally{ancestors.delete(value);}
 }
 const requests=encode(value.requests);for(const request of value.requests)if(Object.keys(fields(request)).length!==1)throw invalid();const body='{"requests":'+requests+',"writeControl":{"requiredRevisionId":'+JSON.stringify(value.requiredRevisionId)+'}}';if(Buffer.byteLength(body)>1048576)throw invalid();
 const url=value.kind==='document'?'https://docs.googleapis.com/v1/documents/':'https://slides.googleapis.com/v1/presentations/';return Object.freeze({url:url+reference+':batchUpdate',body,reference,requiredRevisionId:value.requiredRevisionId,responseId:value.kind==='document'?'documentId':'presentationId',count:value.requests.length});
}
function interrupt<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted){void work.catch(()=>{});return Promise.reject(new ProviderError('PROVIDER_UNAVAILABLE'));}return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(new ProviderError('PROVIDER_UNAVAILABLE'));};signal.addEventListener('abort',abort,{once:true});work.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});
}
type Dispatch=ProviderCheck&{beforeDispatch:()=>void|Promise<void>};
/** Worker-only one-shot HTTP protocol, not a public adapter or source delivery receipt.
 * Caller must compile a current, snapshot-bound command and durably mark dispatch before HTTP.
 * Lost acknowledgements require journal/readback reconciliation, never automatic POST replay. */
export class GoogleNativeWrite{
 private auth:GoogleAuthorization;private request:typeof fetch;private timeoutMs:number;private closed=false;private active=new Map<AbortController,Promise<void>>();private draining:Promise<void>|undefined;
 constructor(auth:GoogleAuthorization,options:{fetch?:typeof fetch;timeoutMs?:number}={}){this.auth=auth;this.request=options.fetch??fetch;this.timeoutMs=options.timeoutMs??30000;if(!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>30000)throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
 async apply(input:GoogleNativeUpdate,options:Dispatch):Promise<Readonly<{reference:string;revision:string}>>{
  const command=encodeGoogleNativeUpdate(input),parent=options.signal,checkAuthority=options.check,beforeDispatch=options.beforeDispatch;if(typeof checkAuthority!=='function'||typeof beforeDispatch!=='function')throw invalid();if(this.closed||parent?.aborted)throw new ProviderError('PROVIDER_CANCELLED');if(this.active.size>=4)throw new ProviderError('PROVIDER_UNAVAILABLE');
  const controller=new AbortController();let done!:()=>void;this.active.set(controller,new Promise<void>(resolve=>done=resolve));const abort=()=>controller.abort();parent?.addEventListener('abort',abort,{once:true});if(parent?.aborted)abort();const timer=setTimeout(abort,this.timeoutMs);let dispatched=false,rejected=false,response:Response|undefined;
  const check=async()=>{if(controller.signal.aborted)throw new ProviderError('PROVIDER_UNAVAILABLE');await interrupt(Promise.resolve().then(()=>checkAuthority()),controller.signal);if(controller.signal.aborted)throw new ProviderError('PROVIDER_UNAVAILABLE');};
  try{
   await check();const token=await interrupt(this.auth.access({signal:controller.signal,check}),controller.signal);await check();if(typeof token!=='string'||token.length<1||token.length>65536||/[^\x21-\x7e]/.test(token))throw new ProviderError('PROVIDER_CONFIG_CHANGED');
   await interrupt(Promise.resolve().then(()=>beforeDispatch()),controller.signal);await check();dispatched=true;
   const current=await interrupt<Response>(this.request(command.url,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{authorization:'Bearer '+token,accept:'application/json','content-type':'application/json'},body:command.body}).then(value=>{if(controller.signal.aborted){void value.body?.cancel().catch(()=>{});throw new ProviderError('PROVIDER_UNAVAILABLE');}return value;}),controller.signal);response=current;
   rejected=[400,401,403,404,412,429].includes(current.status);await check();
   if(current.status===401){this.auth.invalidate(token);throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
   if(current.status===400||current.status===404)throw new ProviderError('PROVIDER_SOURCE_CHANGED');if(current.status===412)throw new ProviderError('PROVIDER_CONFLICT');if(current.status===429)throw new ProviderError('PROVIDER_UNAVAILABLE');
   if(current.status===403){const value=await googleJson(current,{signal:controller.signal,maxBytes:65536,check}),error=value.error as {errors?:unknown}|undefined,details=error&&typeof error==='object'&&Array.isArray(error.errors)?error.errors.slice(0,64):[];if(details.some(item=>item&&typeof item==='object'&&['rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded'].includes((item as {reason:string}).reason)))throw new ProviderError('PROVIDER_UNAVAILABLE');throw new ProviderError('ACCESS_DENIED');}
   if(current.status!==200)throw new ProviderError('PROVIDER_UNKNOWN','unknown');const value=await googleJson(current,{signal:controller.signal,maxBytes:65536,check}),control=value.writeControl as Record<string,unknown>|undefined;
   if(value[command.responseId]!==command.reference||!Array.isArray(value.replies)||value.replies.length!==command.count||!control||typeof control!=='object'||Array.isArray(control)||!revision(control.requiredRevisionId)||control.requiredRevisionId===command.requiredRevisionId||Object.hasOwn(control,'targetRevisionId'))throw new ProviderError('PROVIDER_UNKNOWN','unknown');await check();return Object.freeze({reference:command.reference,revision:control.requiredRevisionId});
  }catch(error){const uncertain=dispatched&&!rejected,normalized=safeProviderError(error,uncertain);if(this.closed||parent?.aborted)throw new ProviderError('PROVIDER_CANCELLED',uncertain?'unknown':'not_written');throw new ProviderError(uncertain&&normalized.code==='PROVIDER_UNAVAILABLE'?'PROVIDER_UNKNOWN':normalized.code,uncertain?'unknown':'not_written');}
  finally{void response?.body?.cancel().catch(()=>{});clearTimeout(timer);parent?.removeEventListener('abort',abort);controller.abort();this.active.delete(controller);done();}
 }
 close():Promise<void>{if(this.draining)return this.draining;this.closed=true;const pending=[...this.active.values()];for(const controller of this.active.keys())controller.abort();this.draining=Promise.all(pending).then(()=>{});return this.draining;}
}
