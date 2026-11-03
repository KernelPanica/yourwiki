import {api,ApiError} from './api.ts';
import {parseProviderSync} from './provider-sync-client.ts';
import {blockSession,onSessionBlocked,sessionSnapshot,sessionIsCurrent} from './session-fence.ts';
export type SyncAction={requestId:string;documentId:string;action:'check'|'apply'|'discard';state:'queued'|'done'|'refused';errorCode:string|null};
export type SyncActionSnapshot={ticket:SyncAction|null;busy:boolean;blocked:boolean;uncertain:boolean;errorCode:string|null};
type Options={documentId:string;csrf:string;write:boolean;initial?:unknown;onSessionLost?:()=>void;request?:(url:string,init?:RequestInit)=>Promise<unknown>};
const codes=['SESSION_REQUIRED','ACCESS_DENIED','NOT_FOUND','CONFLICT','OFFICE_ACTIVE','SAVE_PENDING','PROVIDER_CONFIG_CHANGED','PROVIDER_SOURCE_CHANGED','PROVIDER_CONFLICT','PROVIDER_UNAVAILABLE','PROVIDER_EXPORT_LIMIT','INGRESS_QUOTA','INGRESS_INTERRUPTED'];
export function parseSyncAction(value:unknown,id:string):SyncAction{
 const invalid=():never=>{throw new ApiError('INVALID_SYNC_ACTION');};if(!value||typeof value!=='object'||Array.isArray(value))invalid();const row=value as Record<string,unknown>,keys=['requestId','documentId','action','state','errorCode'];
 if(Object.keys(row).length!==5||Object.keys(row).some(key=>!keys.includes(key))||row.documentId!==id||typeof row.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.requestId)||typeof row.action!=='string'||!['check','apply','discard'].includes(row.action)||typeof row.state!=='string'||!['queued','done','refused'].includes(row.state)||(row.state==='refused'?(typeof row.errorCode!=='string'||!codes.includes(row.errorCode)):row.errorCode!==null))invalid();
 return {requestId:row.requestId as string,documentId:id,action:row.action as SyncAction['action'],state:row.state as SyncAction['state'],errorCode:row.errorCode as string|null};
}
/** Explicit actions only; uncertain acknowledgement is resolved by receipt GET, never POST replay. */
export class ProviderSyncActionClient{
 private options:Options;private request:NonNullable<Options['request']>;private generation:number;private lifetime=new AbortController();private disposed=false;private running=false;private refresh=false;private listeners=new Set<()=>void>();private removeFence:()=>void;
 private state:SyncActionSnapshot={ticket:null,busy:false,blocked:false,uncertain:false,errorCode:null};
 constructor(options:Options){if(!options.documentId||!options.csrf||typeof options.write!=='boolean')throw new Error('INVALID_SYNC_ACTION_OPTIONS');this.options={...options};this.request=options.request??api;this.generation=sessionSnapshot().generation;if(options.initial!=null)try{this.state.ticket=parseSyncAction(options.initial,options.documentId);}catch{this.state.errorCode='INVALID_SYNC_ACTION';}this.removeFence=onSessionBlocked(()=>{this.lifetime.abort();this.update({ticket:null,busy:false,blocked:true,uncertain:false,errorCode:'SESSION_REQUIRED'});});}
 private current(){return !this.disposed&&!this.lifetime.signal.aborted&&sessionIsCurrent(this.generation);}
 snapshot():SyncActionSnapshot{return this.current()?{...this.state,ticket:this.state.ticket?{...this.state.ticket}:null}:{ticket:null,busy:false,blocked:true,uncertain:false,errorCode:'SESSION_REQUIRED'};}
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private update(value:Partial<SyncActionSnapshot>){if(this.disposed)return;this.state={...this.state,...value};for(const listener of [...this.listeners])try{listener();}catch{/* Optional controls cannot interrupt the editor. */}}
 private url(){return '/api/documents/'+encodeURIComponent(this.options.documentId)+'/provider-sync';}
 private denied(error:unknown){if(!(error instanceof ApiError))return false;if(['SESSION_REQUIRED','CSRF_REJECTED'].includes(error.code)){blockSession();this.options.onSessionLost?.();return true;}if(['ACCESS_DENIED','NOT_FOUND'].includes(error.code)){this.update({ticket:null,blocked:true,uncertain:false,errorCode:error.code});return true;}return false;}
 private async read(){
  const old=this.state.ticket;
  if(old&&(old.state==='queued'||this.state.uncertain)){
   let raw:unknown;
   try{raw=await this.request(this.url()+'/actions/'+old.requestId,{signal:this.lifetime.signal});}
   catch(error){
    if(!(this.state.uncertain&&error instanceof ApiError&&error.code==='NOT_FOUND'))throw error;
    // A missing request and a hidden document share a 404. Recheck current document access.
    try{const active=await this.request(this.url()+'/actions',{signal:this.lifetime.signal});this.parseActive(active);}
    catch(accessError){if(this.current())this.denied(accessError);throw accessError;}
    return; // No receipt is not proof of rejection; retain the UUID and uncertainty.
   }
   const result=parseSyncAction(raw,this.options.documentId);
   if(result.requestId!==old.requestId||result.action!==old.action)throw new ApiError('INVALID_SYNC_ACTION');
   if(this.current())this.update({ticket:result,uncertain:false,errorCode:null});
  }else{
   const result=await this.request(this.url()+'/actions',{signal:this.lifetime.signal});
   const ticket=this.parseActive(result);
   if(this.current())this.update({ticket,uncertain:false});
  }
 }
 private parseActive(result:unknown){
  if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).length!==1||!('action' in result))throw new ApiError('INVALID_SYNC_ACTION');
  const ticket=result.action===null?null:parseSyncAction(result.action,this.options.documentId);if(ticket&&ticket.state!=='queued')throw new ApiError('INVALID_SYNC_ACTION');return ticket;
 }
 private finished(){this.running=false;if(!this.current())return;this.update({busy:false});if(this.refresh){this.refresh=false;void this.load();}}
 async load(){if(!this.current()||this.state.blocked)return;if(this.running){this.refresh=true;return;}this.running=true;this.update({busy:true});try{await this.read();}catch(error){if(this.current()&&!(this.state.uncertain&&error instanceof ApiError&&error.code==='NOT_FOUND')&&!this.denied(error))this.update({errorCode:error instanceof ApiError?error.code:'NETWORK_ERROR'});}finally{this.finished();}}
 async submit(kind:SyncAction['action'],source:unknown){
  if(!this.current()||this.running||this.state.blocked||this.state.uncertain||!this.options.write||this.state.ticket?.state==='queued'||!['check','apply','discard'].includes(kind))return;
  let value;try{value=parseProviderSync(source,this.options.documentId);}catch{return;}
  if(value.state==='local_only'||value.providerRevision===null||kind==='apply'&&(!['staged','conflict'].includes(value.state)||!value.snapshotId||value.localRevision!==value.providerRevision)||kind==='discard'&&(!value.snapshotId||!['staged','conflict','failed','interrupted','cleanup','blocked'].includes(value.state)))return;
  const ticket:SyncAction={requestId:crypto.randomUUID(),documentId:this.options.documentId,action:kind,state:'queued',errorCode:null};this.running=true;this.update({ticket,busy:true,errorCode:null});
  try{const result=parseSyncAction(await this.request(this.url()+'/'+kind,{method:'POST',signal:this.lifetime.signal,headers:{'content-type':'application/json','x-csrf-token':this.options.csrf},body:JSON.stringify({requestId:ticket.requestId,baseLocalRevision:value.localRevision,snapshotId:value.snapshotId})}),this.options.documentId);if(result.requestId!==ticket.requestId||result.action!==kind)throw new ApiError('INVALID_SYNC_ACTION');if(this.current())this.update({ticket:result,uncertain:false});}
  catch(error){if(!this.current()||this.denied(error))return;const definite=error instanceof ApiError&&['CONFLICT','OPERATION_MISMATCH','SYNC_ACTION_PENDING','INVALID_REQUEST','PROVIDER_CONFIG_CHANGED'].includes(error.code);this.update({ticket:definite?null:ticket,uncertain:!definite,errorCode:error instanceof ApiError?error.code:'SYNC_ACTION_UNCERTAIN'});try{await this.read();}catch(readError){if(this.current()){
   // Missing exact receipt after a lost ACK does not prove that POST was rejected.
   if(!(this.state.uncertain&&readError instanceof ApiError&&readError.code==='NOT_FOUND'))this.denied(readError);
  }}}
  finally{this.finished();}
 }
 dispose(){if(this.disposed)return;this.disposed=true;this.lifetime.abort();this.removeFence();this.listeners.clear();}
}
