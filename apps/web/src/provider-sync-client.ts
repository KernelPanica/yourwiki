import {api,ApiError} from './api.ts';
import {blockSession,onSessionBlocked,sessionSnapshot,sessionIsCurrent} from './session-fence.ts';
export type IncomingSync={documentId:string;kind:'incoming';state:'local_only'|'idle'|'scheduled'|'checking'|'staged'|'conflict'|'applied'|'failed'|'interrupted'|'cleanup'|'blocked';localRevision:number;providerRevision:number|null;snapshotId:string|null;errorCode:string|null};
export type SyncSnapshot={value:IncomingSync|null;busy:boolean;blocked:boolean;errorCode:string|null};
type Options={documentId:string;initial?:unknown;onSessionLost?:()=>void;request?:(url:string,init?:RequestInit)=>Promise<unknown>};
const states=['local_only','idle','scheduled','checking','staged','conflict','applied','failed','interrupted','cleanup','blocked'],codes=['CONFLICT','OFFICE_ACTIVE','SAVE_PENDING','INGRESS_INTERRUPTED','INGRESS_QUOTA','PROVIDER_CONFIG_CHANGED','PROVIDER_SOURCE_CHANGED','PROVIDER_CONFLICT','PROVIDER_UNAVAILABLE','PROVIDER_EXPORT_LIMIT'];
export function parseProviderSync(value:unknown,id:string):IncomingSync{
 const invalid=():never=>{throw new ApiError('INVALID_PROVIDER_SYNC');};if(!value||typeof value!=='object'||Array.isArray(value))invalid();const row=value as Record<string,unknown>,keys=['documentId','kind','state','localRevision','providerRevision','snapshotId','errorCode'];
 if(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key))||row.documentId!==id||row.kind!=='incoming'||typeof row.state!=='string'||!states.includes(row.state)||!Number.isSafeInteger(row.localRevision)||Number(row.localRevision)<1||row.providerRevision!==null&&(!Number.isSafeInteger(row.providerRevision)||Number(row.providerRevision)<1||Number(row.providerRevision)>Number(row.localRevision))||row.snapshotId!==null&&(typeof row.snapshotId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.snapshotId))||row.errorCode!==null&&(typeof row.errorCode!=='string'||!codes.includes(row.errorCode)))invalid();
 if(['staged','conflict','cleanup','applied'].includes(String(row.state))&&row.snapshotId===null||row.state==='local_only'&&(row.snapshotId!==null||row.errorCode!==null))invalid();
 return {documentId:id,kind:'incoming',state:row.state as IncomingSync['state'],localRevision:Number(row.localRevision),providerRevision:row.providerRevision as number|null,snapshotId:row.snapshotId as string|null,errorCode:row.errorCode as string|null};
}
/** Read-only optional notice. Never saves, reloads or closes the mounted editor. */
export class ProviderSyncClient {
 private options:Options;private request:NonNullable<Options['request']>;private generation:number;private lifetime=new AbortController();private disposed=false;private running=false;private refresh=false;private removeFence:()=>void;private listeners=new Set<()=>void>();private state:SyncSnapshot={value:null,busy:false,blocked:false,errorCode:null};
 constructor(options:Options){if(!options.documentId)throw new Error('INVALID_PROVIDER_SYNC_OPTIONS');this.options={...options};this.request=options.request??api;this.generation=sessionSnapshot().generation;if(options.initial!==undefined)try{this.state.value=parseProviderSync(options.initial,options.documentId);}catch{this.state.errorCode='INVALID_PROVIDER_SYNC';}this.removeFence=onSessionBlocked(()=>{this.lifetime.abort();this.update({value:null,blocked:true,busy:false,errorCode:'SESSION_REQUIRED'});});}
 private current(){return !this.disposed&&!this.lifetime.signal.aborted&&sessionIsCurrent(this.generation);}
 snapshot():SyncSnapshot{if(!this.current())return {value:null,busy:false,blocked:true,errorCode:'SESSION_REQUIRED'};return {...this.state,value:this.state.value?{...this.state.value}:null};}
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private update(value:Partial<SyncSnapshot>){if(this.disposed)return;this.state={...this.state,...value};for(const listener of [...this.listeners])try{listener();}catch{/* An optional notice cannot stop other listeners. */}}
 async load(){
  if(!this.current()||this.state.blocked)return;if(this.running){this.refresh=true;return;}this.running=true;this.update({busy:true});
  try{const value=parseProviderSync(await this.request('/api/documents/'+encodeURIComponent(this.options.documentId)+'/provider-sync',{signal:this.lifetime.signal}),this.options.documentId);if(!this.current())return;const old=this.state.value;if(old&&(value.localRevision<old.localRevision||old.providerRevision!==null&&(value.providerRevision===null||value.providerRevision<old.providerRevision)))throw new ApiError('INVALID_PROVIDER_SYNC');this.update({value,errorCode:null});}
  catch(error){if(!this.current())return;if(error instanceof ApiError&&error.code==='SESSION_REQUIRED'){blockSession();this.options.onSessionLost?.();}else if(error instanceof ApiError&&['NOT_FOUND','ACCESS_DENIED'].includes(error.code))this.update({value:null,blocked:true,errorCode:error.code});else this.update({errorCode:error instanceof ApiError?error.code:'NETWORK_ERROR'});}
  finally{this.running=false;if(this.current()){this.update({busy:false});if(this.refresh){this.refresh=false;void this.load();}}}
 }
 dispose(){if(this.disposed)return;this.disposed=true;this.lifetime.abort();this.removeFence();this.listeners.clear();}
}
