import {api,ApiError} from './api.ts';
import {blockSession,onSessionBlocked,sessionIsCurrent,sessionSnapshot} from './session-fence.ts';
export type RecoveryItem={id:string;sessionId:string;documentId:string;authorId:string;state:'receiving'|'prepared'|'failed'|'committed'|'discarded';baseRevision:number;createdAt:number|null;size:number|null;errorCode:string|null;download:boolean;discard:boolean};
export type RecoverySnapshot={items:RecoveryItem[];nextCursor:string|null;loading:boolean;pendingId:string|null;blocked:boolean;errorCode:string|null};
type Options={documentId:string;csrf:string;request?:(url:string,init?:RequestInit)=>Promise<unknown>;onSessionLost?:()=>void};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[-A-Za-z0-9_]{1,128}$/.test(v);
function parseItem(value:unknown,documentId:string):RecoveryItem {
 if(!record(value)||!(value.createdAt===undefined||value.createdAt===null||Number.isSafeInteger(value.createdAt)&&Number(value.createdAt)>=0&&Number(value.createdAt)<=8640000000000000)||!id(value.id)||!id(value.sessionId)||value.documentId!==documentId||typeof value.authorId!=='string'||!value.authorId||value.authorId.length>128||(value.state!=='receiving'&&value.state!=='prepared'&&value.state!=='failed'&&value.state!=='committed'&&value.state!=='discarded')||!Number.isSafeInteger(value.baseRevision)||Number(value.baseRevision)<1||!(value.size===null||Number.isSafeInteger(value.size)&&Number(value.size)>=0)||!(value.errorCode===null||typeof value.errorCode==='string'&&/^[A-Z0-9_]{1,64}$/.test(value.errorCode))||typeof value.download!=='boolean'||typeof value.discard!=='boolean'||value.download&&(value.size===null||!['prepared','failed'].includes(value.state))||value.discard&&['committed','discarded'].includes(value.state))throw new ApiError('INVALID_OFFICE_RECOVERY');
 return {id:value.id,sessionId:value.sessionId,documentId,authorId:value.authorId,state:value.state,baseRevision:Number(value.baseRevision),createdAt:value.createdAt==null?null:Number(value.createdAt),size:value.size===null?null:Number(value.size),errorCode:value.errorCode as string|null,download:value.download,discard:value.discard};
}
export function parseRecoveryPage(value:unknown,documentId:string,cursor=''):{items:RecoveryItem[];nextCursor:string|null}{
 if(!record(value)||!Array.isArray(value.items)||value.items.length>50||!(value.nextCursor===null||id(value.nextCursor)))throw new ApiError('INVALID_OFFICE_RECOVERY');
 const items=value.items.map(item=>parseItem(item,documentId));let previous=cursor;
 for(const item of items){if(item.id<=previous||!['receiving','prepared','failed'].includes(item.state))throw new ApiError('INVALID_OFFICE_RECOVERY');previous=item.id;}
 if(value.nextCursor!==null&&(!items.length||value.nextCursor!==previous))throw new ApiError('INVALID_OFFICE_RECOVERY');return {items,nextCursor:value.nextCursor};
}
/** Bounded metadata only. Native downloads stream directly from the authenticated endpoint. */
export class OfficeRecovery {
 private options:Options;private request:NonNullable<Options['request']>;private generation:number;private lifetime=new AbortController();private disposed=false;private removeFence:()=>void;
 private state:RecoverySnapshot={items:[],nextCursor:null,loading:false,pendingId:null,blocked:false,errorCode:null};private listeners=new Set<()=>void>();
 constructor(options:Options){if(!options.documentId||options.documentId.length>128||!options.csrf)throw new Error('INVALID_OFFICE_RECOVERY_OPTIONS');this.options={...options};this.request=options.request??api;this.generation=sessionSnapshot().generation;this.removeFence=onSessionBlocked(()=>{this.lifetime.abort();this.update({items:[],nextCursor:null,loading:false,pendingId:null,blocked:true,errorCode:'SESSION_REQUIRED'});});}
 snapshot():RecoverySnapshot{return {...this.state,items:this.state.items.map(item=>({...item}))};}
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private update(value:Partial<RecoverySnapshot>){if(this.disposed)return;this.state={...this.state,...value};for(const listener of [...this.listeners]){try{listener();}catch{/* Recovery authorization is independent of view listeners. */}}}
 private current(){return !this.disposed&&!this.lifetime.signal.aborted&&sessionIsCurrent(this.generation);}
 private busy(){return this.state.loading||this.state.pendingId!==null;}
 private failed(error:unknown,mutating=false){
  if(!this.current())return;const code=error instanceof ApiError?error.code:'NETWORK_ERROR';
  if(code==='SESSION_REQUIRED'){blockSession();this.options.onSessionLost?.();return;}
  if(mutating){this.update({errorCode:'RECOVERY_DISCARD_UNCERTAIN'});return;}
  if(['ACCESS_DENIED','NOT_FOUND'].includes(code)){this.update({items:[],nextCursor:null,errorCode:code});return;}
  this.update({errorCode:mutating?'RECOVERY_DISCARD_UNCERTAIN':code});
 }
 async load(cursor=''){
  if(!this.current()||this.busy())return;if(cursor&&!id(cursor))throw new Error('INVALID_OFFICE_RECOVERY_CURSOR');this.update({loading:true,errorCode:null});
  try{const value=await this.request(`/api/documents/${encodeURIComponent(this.options.documentId)}/office-recovery?limit=50${cursor?'&cursor='+encodeURIComponent(cursor):''}`,{signal:this.lifetime.signal});if(this.current())this.update(parseRecoveryPage(value,this.options.documentId,cursor));}
  catch(error){this.failed(error);}finally{if(this.current())this.update({loading:false});}
 }
 async next(){if(this.state.nextCursor!==null)await this.load(this.state.nextCursor);}
 private replace(item:RecoveryItem){this.update({items:this.state.items.flatMap(old=>old.id!==item.id?[old]:['receiving','prepared','failed'].includes(item.state)?[item]:[])});}
 async download(copyId:string,start:(url:string)=>void){
  if(!this.current()||this.busy()||!this.state.items.some(item=>item.id===copyId&&item.download))return;this.update({pendingId:copyId,errorCode:null});
  try{const value=await this.request(`/api/office-recovery/${encodeURIComponent(copyId)}`,{signal:this.lifetime.signal});if(!this.current())return;const item=parseItem(value,this.options.documentId);if(item.id!==copyId)throw new ApiError('INVALID_OFFICE_RECOVERY');this.replace(item);if(!item.download)throw new ApiError('RECOVERY_EXPORT_DENIED');start(`/api/office-recovery/${encodeURIComponent(copyId)}/contents`);}
  catch(error){this.failed(error);}finally{if(this.current())this.update({pendingId:null});}
 }
 async discard(copyId:string){
  if(!this.current()||this.busy()||!this.state.items.some(item=>item.id===copyId&&item.discard))return;this.update({pendingId:copyId,errorCode:null});let mutating=false;
  try{
   const value=await this.request(`/api/office-recovery/${encodeURIComponent(copyId)}`,{signal:this.lifetime.signal});if(!this.current())return;const item=parseItem(value,this.options.documentId);if(item.id!==copyId)throw new ApiError('INVALID_OFFICE_RECOVERY');this.replace(item);if(!item.discard)throw new ApiError('RECOVERY_UNAVAILABLE');
   mutating=true;const receipt=await this.request(`/api/office-recovery/${encodeURIComponent(copyId)}/discard`,{method:'POST',signal:this.lifetime.signal,headers:{'x-csrf-token':this.options.csrf}});if(!this.current())return;if(receipt!==undefined)throw new ApiError('INVALID_RECOVERY_DISCARD_ACK');this.update({items:this.state.items.filter(item=>item.id!==copyId)});
  }catch(error){this.failed(error,mutating);}finally{if(this.current())this.update({pendingId:null});}
 }
 dispose(){if(this.disposed)return;this.disposed=true;this.lifetime.abort();this.removeFence();this.listeners.clear();}
}
