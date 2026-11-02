import {ProviderError,type ProviderCheck} from './adapter.ts';
import type {GoogleAuthorization} from './credential-vault.ts';
import {googleFileId} from './google-read-http.ts';
import {googleJson} from './google-json.ts';
type NativeKind='document'|'spreadsheet'|'presentation';
export const googleExportTypes={document:{format:'docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},spreadsheet:{format:'ods',mimeType:'application/vnd.oasis.opendocument.spreadsheet'},presentation:{format:'pptx',mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation'}} as const;
export const googleExportMaxBytes=10*1024*1024;
type Options={fetch?:typeof fetch;timeoutMs?:number;totalMs?:number};
class AuthorityFailure{cause:unknown;constructor(cause:unknown){this.cause=cause;}}
function unavailable(){return new ProviderError('PROVIDER_UNAVAILABLE');}
function interrupt<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted){void pending.catch(()=>{});return Promise.reject(unavailable());}
 return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(unavailable());};signal.addEventListener('abort',abort,{once:true});pending.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});
}
/** Worker-only bounded content GETs. Metadata ownership/root/native-kind checks are required
 * before calling and again after complete consumption. No write, redirect or body retry. */
export class GoogleContentHttp{
 private auth:GoogleAuthorization;private request:typeof fetch;private timeoutMs:number;private totalMs:number;private closed=false;private draining:Promise<void>|undefined;private active=new Map<AbortController,AsyncGenerator<Uint8Array,void,unknown>>();
 constructor(auth:GoogleAuthorization,options:Options={}){
  this.auth=auth;this.request=options.fetch??fetch;this.timeoutMs=options.timeoutMs??30000;this.totalMs=options.totalMs??1800000;
  if(!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>30000||!Number.isSafeInteger(this.totalMs)||this.totalMs<1||this.totalMs>3600000)throw new ProviderError('PROVIDER_CONFIG_CHANGED');
 }
 binary(id:string,size:number,options:ProviderCheck):AsyncIterable<Uint8Array>{googleFileId(id);if(!Number.isSafeInteger(size)||size<0||size>4294967296)throw new ProviderError('PROVIDER_INVALID_REFERENCE');return this.stream(id+'?alt=media',size,options,false);}
 export(id:string,kind:NativeKind,options:ProviderCheck):AsyncIterable<Uint8Array>{googleFileId(id);if(!Object.hasOwn(googleExportTypes,kind))throw new ProviderError('PROVIDER_INVALID_REFERENCE');return this.stream(id+'/export?'+new URLSearchParams({mimeType:googleExportTypes[kind].mimeType}),null,options,true);}
 private stream(path:string,expected:number|null,options:ProviderCheck,native:boolean):AsyncGenerator<Uint8Array,void,unknown>{
  const self=this;let iterator!:AsyncGenerator<Uint8Array,void,unknown>;
  iterator=(async function*(){
   if(self.closed||options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');if(self.active.size>=2)throw unavailable();
   const controller=new AbortController(),abort=()=>controller.abort(),total=setTimeout(abort,self.totalMs);let idle:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,response:Response|undefined;
   self.active.set(controller,iterator);options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
   const touch=()=>{clearTimeout(idle);idle=setTimeout(abort,self.timeoutMs);};touch();
   const cancel=()=>{if(reader)void reader.cancel().catch(()=>{});else if(response)void response.body?.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
   const check=async()=>{if(controller.signal.aborted)throw unavailable();try{await interrupt(Promise.resolve().then(()=>options.check()),controller.signal);}catch(error){if(controller.signal.aborted)throw unavailable();throw new AuthorityFailure(error);}if(controller.signal.aborted)throw unavailable();};
   try{
    for(let attempt=0;attempt<2;attempt++){
     await check();touch();const token=await interrupt(self.auth.access({signal:controller.signal,check}),controller.signal);await check();
     if(typeof token!=='string'||token.length<1||token.length>65536||/[^\x21-\x7e]/.test(token))throw new ProviderError('PROVIDER_CONFIG_CHANGED');
     touch();const received=await interrupt(self.request('https://www.googleapis.com/drive/v3/files/'+path,{method:'GET',redirect:'manual',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/octet-stream','accept-encoding':'identity',authorization:'Bearer '+token}}).then(value=>{if(controller.signal.aborted){void value.body?.cancel().catch(()=>{});throw unavailable();}return value;}),controller.signal);
     response=received;await check();
     if(received.status===401){void received.body?.cancel().catch(()=>{});self.auth.invalidate(token);if(attempt===0)continue;throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
     if(received.status===400||received.status===403){
      const data=await googleJson(received,{signal:controller.signal,maxBytes:65536,check});const error=data.error as {errors?:unknown}|undefined,details=error&&typeof error==='object'&&Array.isArray(error.errors)?error.errors.slice(0,64):[],reasons=details.map(item=>item&&typeof item==='object'?(item as any).reason:undefined);
      if(native&&reasons.includes('exportSizeLimitExceeded'))throw new ProviderError('PROVIDER_EXPORT_LIMIT');
      if(reasons.some(reason=>['rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded','downloadQuotaExceeded'].includes(reason)))throw unavailable();
      throw new ProviderError(received.status===403?'ACCESS_DENIED':'PROVIDER_CONFIG_CHANGED');
     }
     if(received.status!==200){if(received.status===404)throw new ProviderError('PROVIDER_SOURCE_CHANGED');if(received.status===412)throw new ProviderError('PROVIDER_CONFLICT');throw unavailable();}
     const encoding=received.headers.get('content-encoding');if(encoding!==null&&encoding.toLowerCase()!=='identity')throw unavailable();
     const header=received.headers.get('content-length'),limit=expected??googleExportMaxBytes;
     if(header!==null){if(!/^(0|[1-9][0-9]{0,19})$/.test(header))throw unavailable();const declared=BigInt(header);if(native&&declared>BigInt(limit))throw new ProviderError('PROVIDER_EXPORT_LIMIT');if(expected!==null&&declared!==BigInt(expected))throw new ProviderError('PROVIDER_SOURCE_CHANGED');}
     if(!received.body){if(expected===0){await check();return;}throw unavailable();}
     reader=received.body.getReader();let size=0,empty=0;
     for(;;){
      await check();touch();const part=await interrupt(reader.read(),controller.signal);await check();if(part.done)break;
      if(!(part.value instanceof Uint8Array))throw unavailable();if(!part.value.byteLength&&++empty>65536)throw unavailable();
      if(size+part.value.byteLength>limit)throw new ProviderError(native?'PROVIDER_EXPORT_LIMIT':'PROVIDER_SOURCE_CHANGED');size+=part.value.byteLength;
      for(let offset=0;offset<part.value.byteLength;offset+=65536){await check();yield Uint8Array.from(part.value.subarray(offset,offset+65536));}
     }
     if(expected!==null&&size!==expected)throw new ProviderError('PROVIDER_SOURCE_CHANGED');await check();return;
    }
    throw unavailable();
   }catch(error){
    if(self.closed||options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');
    if(error instanceof AuthorityFailure){let cause=error.cause;while(cause instanceof AuthorityFailure)cause=cause.cause;throw cause;}
    if(error instanceof ProviderError)throw error;throw unavailable();
   }finally{
    clearTimeout(total);clearTimeout(idle);options.signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',cancel);cancel();if(reader)try{reader.releaseLock();}catch{/* Pending cancelled reads retain their own cleanup. */}controller.abort();self.active.delete(controller);
   }
  })();return (async function*(){for await(const chunk of iterator){if(self.closed)throw new ProviderError('PROVIDER_CANCELLED');yield chunk;}if(self.closed)throw new ProviderError('PROVIDER_CANCELLED');})();
 }
 /** Explicit return() also drains a generator paused at a consumer yield. Does not own shared OAuth. */
 close():Promise<void>{if(this.draining)return this.draining;this.closed=true;const active=[...this.active.entries()];for(const [controller] of active)controller.abort();this.draining=Promise.allSettled(active.map(([,iterator])=>iterator.return(undefined))).then(()=>{});return this.draining;}
}
