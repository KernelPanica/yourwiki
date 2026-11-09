import {ProviderError,type ProviderCheck} from './adapter.ts';
import type {GoogleAuthorization} from './credential-vault.ts';
import {googleJson} from './google-json.ts';
export type GoogleControlScope=ProviderCheck&{beforeDispatch?:()=>void|Promise<void>};
/** Bounded control plane. Never accepts an arbitrary origin, streams content, or retries writes. */
export class GoogleControlHttp {
 private auth:GoogleAuthorization;private request:typeof fetch;private lifetime=new AbortController();private active=new Set<Promise<unknown>>();
 constructor(auth:GoogleAuthorization,options:{fetch?:typeof fetch}={}){this.auth=auth;this.request=options.fetch??fetch;}
 call(method:'GET'|'POST'|'PATCH'|'DELETE',path:string,query:Record<string,string>,body:unknown,scope:GoogleControlScope):Promise<Record<string,unknown>>{
  if(!/^(?:files(?:\/[A-Za-z0-9_-]{1,256}(?:\/(?:watch|permissions(?:\/[A-Za-z0-9_-]{1,256})?))?)?|files\/generateIds|changes(?:\/startPageToken)?|about)$/.test(path)||Object.keys(query).some(k=>!['fields','pageSize','pageToken','q','spaces','corpora','count','type','space','addParents','removeParents','sendNotificationEmail','supportsAllDrives','restrictToMyDrive','includeRemoved'].includes(k)))return Promise.reject(new ProviderError('PROVIDER_INVALID_REFERENCE'));
  if(this.active.size>=8||this.lifetime.signal.aborted)return Promise.reject(new ProviderError('PROVIDER_UNAVAILABLE'));
  const work=this.perform(method,path,{...query},body,scope).finally(()=>this.active.delete(work));this.active.add(work);return work;
 }
 private async perform(method:string,path:string,query:Record<string,string>,body:unknown,scope:GoogleControlScope){
  const write=method!=='GET',controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000),signal=AbortSignal.any([controller.signal,this.lifetime.signal,...(scope.signal?[scope.signal]:[])]);let dispatched=false,response:Response|undefined;
  const wait=<T>(promise:Promise<T>):Promise<T>=>{if(signal.aborted){void promise.catch(()=>{});return Promise.reject(new ProviderError('PROVIDER_CANCELLED'));}return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(new ProviderError('PROVIDER_CANCELLED'));};signal.addEventListener('abort',abort,{once:true});promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});};
  const check=async()=>{if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');await wait(Promise.resolve().then(()=>scope.check()));if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');};
  try{const encoded=body===undefined?undefined:JSON.stringify(body);if(encoded!==undefined&&Buffer.byteLength(encoded)>65536)throw new ProviderError('PROVIDER_INVALID_REFERENCE');if(write&&typeof scope.beforeDispatch!=='function')throw new ProviderError('PROVIDER_INVALID_REFERENCE');
   for(let attempt=0;attempt<(write?1:2);attempt++){
    await check();const token=await wait(this.auth.access({signal,check}));await check();if(typeof token!=='string'||!token||token.length>65536||/[^\x21-\x7e]/.test(token))throw new ProviderError('PROVIDER_CONFIG_CHANGED');
    if(write){await wait(Promise.resolve().then(()=>scope.beforeDispatch!()));await check();dispatched=true;}
    const currentResponse:Response=await wait<Response>(this.request('https://www.googleapis.com/drive/v3/'+path+'?'+new URLSearchParams(query),{method,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal,headers:{authorization:'Bearer '+token,accept:'application/json',...(encoded===undefined?{}:{'content-type':'application/json'})},body:encoded}).then(r=>{if(signal.aborted){void r.body?.cancel().catch(()=>{});throw new ProviderError('PROVIDER_CANCELLED');}return r;}));
    response=currentResponse;const status=currentResponse.status;if(status===401){this.auth.invalidate(token);void currentResponse.body?.cancel().catch(()=>{});dispatched=false;if(!write&&attempt===0)continue;throw new ProviderError('PROVIDER_CONFIG_CHANGED');}
    if([400,403,404,409,412,429].includes(status)){dispatched=false;throw new ProviderError(status===403?'ACCESS_DENIED':status===404||status===400?'PROVIDER_SOURCE_CHANGED':status===429?'PROVIDER_UNAVAILABLE':'PROVIDER_CONFLICT');}
    if(status<200||status>=300)throw new ProviderError(write?'PROVIDER_UNKNOWN':'PROVIDER_UNAVAILABLE',write?'unknown':'not_written');await check();if(status===204){void currentResponse.body?.cancel().catch(()=>{});return {};}
    const value=await googleJson(currentResponse,{signal,maxBytes:1048576,check});await check();return value;
   }throw new ProviderError('PROVIDER_CONFIG_CHANGED');
  }catch(error){if(error instanceof ProviderError)throw new ProviderError(error.code,write&&dispatched?'unknown':error.outcome);if(error&&typeof error==='object'&&'code' in error&&['ACCESS_DENIED','SESSION_REQUIRED','LEASE_LOST','CONFLICT','PROVIDER_CONFIG_CHANGED'].includes(String(error.code)))throw new ProviderError(String(error.code),write&&dispatched?'unknown':'not_written');throw new ProviderError(write&&dispatched?'PROVIDER_UNKNOWN':'PROVIDER_UNAVAILABLE',write&&dispatched?'unknown':'not_written');}
  finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 }
 async close(){this.lifetime.abort();await Promise.allSettled([...this.active]);}
}
