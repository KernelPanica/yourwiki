import {api,ApiError} from './api.ts';
import {blockSession,onSessionBlocked,sessionIsCurrent,sessionSnapshot} from './session-fence.ts';
export type DiscoveredFile={id:string;name:string;kind:'folder'|'binary'|'document'|'spreadsheet'|'presentation'};
type Page={folderId:string;items:DiscoveredFile[]};
type Trail={id:string;name:string}[];
export type DiscoverySnapshot={phase:'idle'|'submitting'|'queued'|'running'|'ready'|'failed'|'unknown'|'blocked';busy:boolean;page:Page|null;operationId:string|null;hasMore:boolean;trail:Trail;errorCode:string|null};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,fileId=/^[A-Za-z0-9_-]{1,256}$/;
const invalid=():never=>{throw new ApiError('INVALID_GOOGLE_DISCOVERY');};
const record=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))invalid();return value as Record<string,unknown>;};
export function parseGoogleDiscovery(value:unknown,expectedId?:string){
 const row=record(value),keys=['operationId','state','page','hasMore','errorCode'];if(Object.keys(row).length!==keys.length||Object.keys(row).some(k=>!keys.includes(k))||typeof row.operationId!=='string'||!uuid.test(row.operationId)||expectedId!==undefined&&row.operationId!==expectedId||typeof row.state!=='string'||!['queued','running','succeeded','failed'].includes(row.state)||typeof row.hasMore!=='boolean'||row.errorCode!==null&&(typeof row.errorCode!=='string'||!['PROVIDER_CONFIG_CHANGED','PROVIDER_SOURCE_CHANGED','PROVIDER_INVALID_REFERENCE','PROVIDER_CONFLICT','PROVIDER_UNAVAILABLE','ACCESS_DENIED','RETRY_EXHAUSTED'].includes(row.errorCode)))invalid();
 let page:Page|null=null;
 if(row.page!==null){const raw=record(row.page);if(row.state!=='succeeded'||Object.keys(raw).length!==2||typeof raw.folderId!=='string'||!fileId.test(raw.folderId)||!Array.isArray(raw.items)||raw.items.length>100)invalid();const seen=new Set<string>();
  const items=(raw.items as unknown[]).map(value=>{const file=record(value),allowed=['id','name','kind','mimeType','version','parents','size','md5','sha256','headRevision'];if(Object.keys(file).some(key=>!allowed.includes(key))||typeof file.id!=='string'||!fileId.test(file.id)||seen.has(file.id)||file.id===raw.folderId||typeof file.name!=='string'||!file.name||new TextEncoder().encode(file.name).length>4096||new TextDecoder().decode(new TextEncoder().encode(file.name))!==file.name||/[\x00-\x1f\x7f]/.test(file.name)||typeof file.kind!=='string'||!['folder','binary','document','spreadsheet','presentation'].includes(file.kind)||typeof file.mimeType!=='string'||file.kind==='binary'&&file.mimeType.startsWith('application/vnd.google-apps.')||file.kind!=='binary'&&file.mimeType!=='application/vnd.google-apps.'+file.kind)invalid();seen.add(file.id as string);return {id:file.id as string,name:file.name as string,kind:file.kind as DiscoveredFile['kind']};});page={folderId:raw.folderId as string,items};
 }
 if((row.state==='succeeded')!==(page!==null)||row.hasMore&&page===null||row.state==='succeeded'&&row.errorCode!==null)invalid();return {operationId:row.operationId as string,state:row.state as 'queued'|'running'|'succeeded'|'failed',page,hasMore:row.hasMore as boolean,errorCode:row.errorCode as string|null};
}
type Options={connectionId:string;revision:number;csrf:string;request?:(url:string,init?:RequestInit)=>Promise<unknown>;pollMs?:number;onSessionLost?:()=>void};
type Input={requestId:string;connectionId:string;baseRevision:number;folderId:string|null;previousOperationId:string|null};
/** Explicit inventory browsing only. No source content, importing or provider cursor in client state. */
export class GoogleDiscoveryClient{
 private options:Options;private request:NonNullable<Options['request']>;private generation=sessionSnapshot().generation;private lifetime=new AbortController();private disposed=false;private running=false;private timer:ReturnType<typeof setTimeout>|undefined;private removeFence:()=>void;private listeners=new Set<()=>void>();private startedAt=0;private failures=0;
 private pending:{input:Input;trail:Trail}|undefined;private pageOperationId:string|null=null;
 private state:DiscoverySnapshot={phase:'idle',busy:false,page:null,operationId:null,hasMore:false,trail:[],errorCode:null};
 constructor(options:Options){if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(options.connectionId)||!Number.isSafeInteger(options.revision)||options.revision<1||!options.csrf||!Number.isSafeInteger(options.pollMs??750)||(options.pollMs??750)<10||(options.pollMs??750)>60000)throw new Error('INVALID_DISCOVERY_OPTIONS');this.options={...options};this.request=options.request??api;this.removeFence=onSessionBlocked(()=>{this.clearTimer();this.lifetime.abort();this.pending=undefined;this.pageOperationId=null;this.update({phase:'blocked',busy:false,page:null,operationId:null,trail:[],hasMore:false,errorCode:'SESSION_REQUIRED'});});}
 private current(){return !this.disposed&&!this.lifetime.signal.aborted&&sessionIsCurrent(this.generation);}
 snapshot():DiscoverySnapshot{return this.current()?{...this.state,page:this.state.page?{...this.state.page,items:this.state.page.items.map(item=>({...item}))}:null,trail:this.state.trail.map(item=>({...item}))}:{phase:'blocked',busy:false,page:null,operationId:null,hasMore:false,trail:[],errorCode:'SESSION_REQUIRED'};}
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private update(value:Partial<DiscoverySnapshot>){if(this.disposed)return;this.state={...this.state,...value};for(const listener of [...this.listeners])try{listener();}catch{/* Private-data fencing does not depend on rendering. */}}
 private clearTimer(){clearTimeout(this.timer);this.timer=undefined;}
 private schedule(){this.clearTimer();if(!this.current())return;if(performance.now()-this.startedAt>=120000){this.update({phase:'unknown',errorCode:'DISCOVERY_WAIT'});return;}this.timer=setTimeout(()=>{this.timer=undefined;void this.check();},Math.min(15000,(this.options.pollMs??750)*2**Math.min(this.failures,4)));}
 private accept(value:unknown){const result=parseGoogleDiscovery(value,this.state.operationId??undefined);if(result.page&&this.pending?.input.folderId&&result.page.folderId!==this.pending.input.folderId)invalid();this.failures=0;
  if(result.state==='failed'&&['ACCESS_DENIED','PROVIDER_CONFIG_CHANGED'].includes(result.errorCode??'')){if(result.errorCode==='ACCESS_DENIED'){this.pending=undefined;this.update({phase:'failed',errorCode:'GOOGLE_ACCESS_DENIED',page:null,operationId:null,hasMore:false});return;}this.error(new ApiError(result.errorCode!));return;}
  if(result.state==='succeeded'){this.pageOperationId=result.operationId;this.update({operationId:result.operationId,page:result.page,hasMore:result.hasMore,errorCode:result.errorCode,phase:'ready',trail:this.pending?.trail.map(x=>({...x}))??this.state.trail});}
  else{this.update({operationId:result.operationId,phase:result.state,errorCode:result.errorCode,hasMore:this.state.hasMore});if(result.state!=='failed')this.schedule();}
 }
 private error(error:unknown){if(!this.current())return;const raw=error instanceof ApiError?error.code:'NETWORK_ERROR',safe=['SESSION_REQUIRED','ACCESS_DENIED','NOT_FOUND','PROVIDER_CONFIG_CHANGED','PROVIDER_UNAVAILABLE','PROVIDER_SOURCE_CHANGED','PROVIDER_CONFLICT','CONFIG_UNAVAILABLE','DISCOVERY_LIMIT','CSRF_REJECTED','INVALID_REQUEST','OPERATION_MISMATCH','INVALID_GOOGLE_DISCOVERY','REQUEST_FAILED','NETWORK_ERROR'];const code=typeof raw==='string'&&safe.includes(raw)?raw:'REQUEST_FAILED';if(code==='SESSION_REQUIRED'){blockSession();this.options.onSessionLost?.();return;}
  if(code==='ACCESS_DENIED'){this.pending=undefined;this.pageOperationId=null;this.update({phase:'blocked',page:null,trail:[],hasMore:false,operationId:null,errorCode:code});return;}
  if(['NOT_FOUND','PROVIDER_CONFIG_CHANGED'].includes(code)){this.pending=undefined;this.pageOperationId=null;this.update({phase:'failed',page:null,trail:[],operationId:null,hasMore:false,errorCode:code});return;}
  if(['DISCOVERY_LIMIT','CSRF_REJECTED','INVALID_REQUEST','OPERATION_MISMATCH','CONFIG_UNAVAILABLE'].includes(code)){this.pending=undefined;this.update({phase:'failed',errorCode:code});return;}
  this.failures++;this.update({phase:'unknown',errorCode:code});
 }
 private async perform(){if(!this.pending||!this.current()||this.running)return;this.clearTimer();this.running=true;this.update({busy:true});try{
  const value=this.state.operationId?await this.request('/api/admin/google/discovery/'+encodeURIComponent(this.state.operationId),{signal:this.lifetime.signal}):await this.request('/api/admin/google/discovery',{method:'POST',signal:this.lifetime.signal,headers:{'content-type':'application/json','x-csrf-token':this.options.csrf},body:JSON.stringify(this.pending.input)});
  if(this.current())this.accept(value);
 }catch(error){this.error(error);}finally{this.running=false;if(this.current())this.update({busy:false});}}
 private async browse(folderId:string|null,trail:Trail,previousOperationId:string|null=null){if(!this.current()||this.running||['queued','running','submitting','unknown','blocked'].includes(this.state.phase))return;this.clearTimer();this.startedAt=performance.now();this.pending={input:{requestId:crypto.randomUUID(),connectionId:this.options.connectionId,baseRevision:this.options.revision,folderId,previousOperationId},trail:trail.map(x=>({...x}))};this.update({phase:'submitting',operationId:null,errorCode:null});await this.perform();}
 start(){return this.browse(this.state.trail.at(-1)?.id??null,this.state.trail);}
 root(){return this.browse(null,[]);}
 back(){const trail=this.state.trail.slice(0,-1);return this.browse(trail.at(-1)?.id??null,trail);}
 enter(id:string){const item=this.state.page?.items.find(x=>x.id===id&&x.kind==='folder');if(!item||this.state.phase!=='ready'||this.state.trail.length>=32||this.state.trail.some(x=>x.id===id))return Promise.resolve();return this.browse(item.id,[...this.state.trail,{id:item.id,name:item.name}]);}
 more(){if(this.state.phase!=='ready'||!this.state.hasMore||!this.pageOperationId)return Promise.resolve();return this.browse(this.state.trail.at(-1)?.id??null,this.state.trail,this.pageOperationId);}
 check(){return this.perform();}
 dispose(){if(this.disposed)return;this.disposed=true;this.clearTimer();this.lifetime.abort();this.pending=undefined;this.pageOperationId=null;this.removeFence();this.listeners.clear();this.state={phase:'blocked',busy:false,page:null,operationId:null,hasMore:false,trail:[],errorCode:null};}
}
