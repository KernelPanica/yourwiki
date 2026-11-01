import {api,ApiError} from './api.ts';
import {blockSession,onSessionBlocked,sessionSnapshot,sessionIsCurrent} from './session-fence.ts';
export type SourceDelivery={documentId:string;kind:'source';state:'local_only'|'pending'|'sending'|'confirmed'|'unknown'|'retryable'|'conflict'|'blocked';localRevision:number;providerRevision:number|null;operationId:string|null;errorCode:string|null};
export type DeliverySnapshot={value:SourceDelivery|null;busy:boolean;blocked:boolean;uncertain:boolean;errorCode:string|null};
type Options={initial?:unknown;documentId:string;csrf:string;write:boolean;onSessionLost?:()=>void;request?:(url:string,init?:RequestInit)=>Promise<unknown>};
const states=['local_only','pending','sending','confirmed','unknown','retryable','conflict','blocked'],codes=['PROVIDER_UNKNOWN','PROVIDER_UNAVAILABLE','PROVIDER_CONFLICT','PROVIDER_CONFIG_CHANGED','PROVIDER_SOURCE_CHANGED','ACCESS_DENIED'];
export function parseSourceDelivery(value:unknown,documentId:string):SourceDelivery{
 const invalid=():never=>{throw new ApiError('INVALID_PROVIDER_DELIVERY');};if(!value||typeof value!=='object'||Array.isArray(value))invalid();const row=value as Record<string,unknown>,keys=['documentId','kind','state','localRevision','providerRevision','operationId','errorCode'];
 if(Object.keys(row).length!==keys.length||Object.keys(row).some(k=>!keys.includes(k))||row.documentId!==documentId||row.kind!=='source'||typeof row.state!=='string'||!states.includes(row.state)||!Number.isSafeInteger(row.localRevision)||Number(row.localRevision)<1||row.providerRevision!==null&&(!Number.isSafeInteger(row.providerRevision)||Number(row.providerRevision)<1||Number(row.providerRevision)>Number(row.localRevision))||row.operationId!==null&&(typeof row.operationId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.operationId))||row.errorCode!==null&&(typeof row.errorCode!=='string'||!codes.includes(row.errorCode)))invalid();
 if(['sending','unknown','retryable','conflict'].includes(row.state as string)&&row.operationId===null||row.state==='confirmed'&&(row.providerRevision!==row.localRevision||row.operationId!==null||row.errorCode!==null)||row.state==='local_only'&&(row.operationId!==null||row.errorCode!==null))invalid();
 return {documentId,kind:'source',state:row.state as SourceDelivery['state'],localRevision:Number(row.localRevision),providerRevision:row.providerRevision as number|null,operationId:row.operationId as string|null,errorCode:row.errorCode as string|null};
}
/** Optional panel only. It never saves/reloads/closes the mounted editor. */
export class ProviderDeliveryClient {
 private options:Options;private request:NonNullable<Options['request']>;private generation:number;private lifetime=new AbortController();private disposed=false;private running=false;private refresh=false;private removeFence:()=>void;private listeners=new Set<()=>void>();
 private state:DeliverySnapshot={value:null,busy:false,blocked:false,uncertain:false,errorCode:null};
 constructor(options:Options){if(!options.documentId||!options.csrf||typeof options.write!=='boolean')throw new Error('INVALID_PROVIDER_DELIVERY_OPTIONS');this.options={...options};this.request=options.request??api;this.generation=sessionSnapshot().generation;if(options.initial!==undefined)try{this.state.value=parseSourceDelivery(options.initial,options.documentId);}catch{this.state.errorCode='INVALID_PROVIDER_DELIVERY';}this.removeFence=onSessionBlocked(()=>{this.lifetime.abort();this.update({value:null,blocked:true,busy:false,errorCode:'SESSION_REQUIRED'});});}
 private current(){return !this.disposed&&!this.lifetime.signal.aborted&&sessionIsCurrent(this.generation);}
 snapshot():DeliverySnapshot{if(!this.current())return {value:null,busy:false,blocked:true,uncertain:false,errorCode:'SESSION_REQUIRED'};return {...this.state,value:this.state.value?{...this.state.value}:null};}
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private update(value:Partial<DeliverySnapshot>){if(this.disposed)return;this.state={...this.state,...value};for(const listener of [...this.listeners])try{listener();}catch{/* A panel cannot replay an action. */}}
 private url(){return '/api/documents/'+encodeURIComponent(this.options.documentId)+'/provider-delivery';}
 private denied(error:unknown){if(!(error instanceof ApiError))return false;if(['SESSION_REQUIRED','CSRF_REJECTED'].includes(error.code)){blockSession();this.options.onSessionLost?.();return true;}if(['ACCESS_DENIED','NOT_FOUND'].includes(error.code)){this.update({value:null,blocked:true,errorCode:error.code});return true;}return false;}
 private parse(value:unknown){const row=parseSourceDelivery(value,this.options.documentId),old=this.state.value;if(old&&(row.localRevision<old.localRevision||old.providerRevision!==null&&(row.providerRevision===null||row.providerRevision<old.providerRevision)))throw new ApiError('INVALID_PROVIDER_DELIVERY');return row;}
 private async read(){const value=this.parse(await this.request(this.url(),{signal:this.lifetime.signal}));if(this.current())this.update({value,blocked:false,errorCode:null});}
 private finished(){this.running=false;if(!this.current())return;this.update({busy:false});if(this.refresh){this.refresh=false;void this.load();}}
 async load(){if(!this.current())return;if(this.running){this.refresh=true;return;}this.running=true;this.update({busy:true});try{await this.read();if(this.current())this.update({uncertain:false});}catch(error){if(this.current()&&!this.denied(error))this.update({errorCode:error instanceof ApiError?error.code:'NETWORK_ERROR'});}finally{this.finished();}}
 async action(action:'retry'|'check'){
  const value=this.state.value;if(!this.current()||this.running||this.state.blocked||this.state.uncertain||!this.options.write||!value?.operationId||action==='retry'&&value.state!=='retryable'||action==='check'&&value.state!=='unknown'||!['retry','check'].includes(action))return;
  this.running=true;this.update({busy:true,errorCode:null});const body={operationId:value.operationId,baseLocalRevision:value.localRevision,...(action==='check'?{requestId:crypto.randomUUID()}:{})};
  try{const result=this.parse(await this.request(this.url()+'/'+action,{method:'POST',signal:this.lifetime.signal,headers:{'content-type':'application/json','x-csrf-token':this.options.csrf},body:JSON.stringify(body)}));if(this.current())this.update({value:result,uncertain:false});}
  catch(error){if(!this.current()||this.denied(error))return;this.update({uncertain:!(error instanceof ApiError&&['CONFLICT','INVALID_REQUEST'].includes(error.code)),errorCode:error instanceof ApiError?error.code:'PROVIDER_ACTION_UNCERTAIN'});try{await this.read();}catch(readError){if(this.current())this.denied(readError);}}
  finally{this.finished();}
 }
 dispose(){if(this.disposed)return;this.disposed=true;this.lifetime.abort();this.removeFence();this.listeners.clear();}
}
