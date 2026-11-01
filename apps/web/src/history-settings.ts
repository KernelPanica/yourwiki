import {api,ApiError} from './api.ts';
import {blockSession,onSessionBlocked,sessionIsCurrent,sessionSnapshot} from './session-fence.ts';
export type HistorySettings={enabled:boolean;revision:number;byteLimit:number;entryLimit:number};
export type HistorySettingsSnapshot={value:HistorySettings|null;desired:boolean|null;phase:'loading'|'ready'|'saving'|'saved'|'conflict'|'unknown'|'error'|'blocked';busy:boolean;errorCode:string|null};
type Options={csrf:string;request?:(url:string,init?:RequestInit)=>Promise<unknown>;onSessionLost?:()=>void};
export function parseHistorySettings(value:unknown):HistorySettings{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError('INVALID_HISTORY_SETTINGS');const row=value as Record<string,unknown>;
 if(typeof row.enabled!=='boolean'||!Number.isSafeInteger(row.revision)||Number(row.revision)<0||!Number.isSafeInteger(row.byteLimit)||Number(row.byteLimit)<1||!Number.isSafeInteger(row.entryLimit)||Number(row.entryLimit)<1||Number(row.entryLimit)>100000)throw new ApiError('INVALID_HISTORY_SETTINGS');
 return {enabled:row.enabled,revision:Number(row.revision),byteLimit:Number(row.byteLimit),entryLimit:Number(row.entryLimit)};
}
/** One explicit mutation at a time. Ambiguous replies trigger reads, never automatic write replay. */
export class HistorySettingsClient{
 private options:Options;private request:NonNullable<Options['request']>;private generation:number;private lifetime=new AbortController();private disposed=false;private running=false;private removeFence:()=>void;private listeners=new Set<()=>void>();
 private state:HistorySettingsSnapshot={value:null,desired:null,phase:'loading',busy:false,errorCode:null};
 constructor(options:Options){if(!options.csrf)throw new Error('INVALID_HISTORY_SETTINGS_OPTIONS');this.options={...options};this.request=options.request??api;this.generation=sessionSnapshot().generation;this.removeFence=onSessionBlocked(()=>{this.lifetime.abort();this.update({value:null,desired:null,phase:'blocked',busy:false,errorCode:'SESSION_REQUIRED'});});}
 snapshot():HistorySettingsSnapshot{if(!this.current())return {value:null,desired:null,phase:'blocked',busy:false,errorCode:'SESSION_REQUIRED'};return {...this.state,value:this.state.value?{...this.state.value}:null};}
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private current(){return !this.disposed&&!this.lifetime.signal.aborted&&sessionIsCurrent(this.generation);}
 private update(value:Partial<HistorySettingsSnapshot>){if(this.disposed)return;this.state={...this.state,...value};for(const listener of [...this.listeners]){try{listener();}catch{/* View failures cannot authorize writes. */}}}
 private denied(error:unknown){const code=error instanceof ApiError?error.code:'NETWORK_ERROR';if(code==='SESSION_REQUIRED'){blockSession();this.options.onSessionLost?.();return true;}if(code==='ACCESS_DENIED'||code==='NOT_FOUND'){this.update({value:null,desired:null,phase:'error',errorCode:code});return true;}return false;}
 private async read(){const result=parseHistorySettings(await this.request('/api/admin/history-settings',{signal:this.lifetime.signal}));if(this.state.value&&result.revision<this.state.value.revision)throw new ApiError('INVALID_HISTORY_SETTINGS');return result;}
 async load(){
  if(!this.current()||this.running)return;this.running=true;this.update({busy:true,phase:'loading',errorCode:null});
  try{const value=await this.read();if(this.current())this.update({value,desired:value.enabled,phase:'ready'});}catch(error){if(this.current()&&!this.denied(error))this.update({phase:'error',errorCode:error instanceof ApiError?error.code:'NETWORK_ERROR'});}finally{this.running=false;if(this.current())this.update({busy:false});}
 }
 private async reconcile(phase:'conflict'|'unknown'){
  try{const value=await this.read();if(!this.current())return;this.update({value,phase:value.enabled===this.state.desired?'saved':phase,errorCode:value.enabled===this.state.desired?null:phase==='conflict'?'CONFLICT':'HISTORY_SETTINGS_UNCERTAIN'});}catch(error){if(this.current()&&!this.denied(error))this.update({phase,errorCode:'HISTORY_SETTINGS_UNCERTAIN'});}
 }
 private async write(desired:boolean,base:HistorySettings){
  this.update({desired,phase:'saving',errorCode:null});
  try{const value=parseHistorySettings(await this.request('/api/admin/history-settings',{method:'PUT',signal:this.lifetime.signal,headers:{'content-type':'application/json','x-csrf-token':this.options.csrf},body:JSON.stringify({enabled:desired,baseRevision:base.revision})}));if(!this.current())return;if(value.enabled!==desired||value.revision!==base.revision+1)throw new ApiError('INVALID_HISTORY_SETTINGS');this.update({value,phase:'saved',errorCode:null});}
  catch(error){if(!this.current()||this.denied(error))return;const phase=error instanceof ApiError&&error.code==='CONFLICT'?'conflict':'unknown';this.update({phase,errorCode:phase==='conflict'?'CONFLICT':'HISTORY_SETTINGS_UNCERTAIN'});await this.reconcile(phase);}
 }
 async setEnabled(desired:boolean){
  if(typeof desired!=='boolean'||!this.current()||this.running||!this.state.value||!['ready','saved','conflict'].includes(this.state.phase))return;if(desired===this.state.value.enabled)return;this.running=true;this.update({busy:true});
  try{await this.write(desired,{...this.state.value});}finally{this.running=false;if(this.current())this.update({busy:false});}
 }
 async retry(){
  if(!this.current()||this.running||this.state.desired===null||!['unknown','conflict'].includes(this.state.phase))return;const desired=this.state.desired;this.running=true;this.update({busy:true});
  try{const value=await this.read();if(!this.current())return;this.update({value});if(value.enabled===desired)this.update({phase:'saved',errorCode:null});else await this.write(desired,value);}
  catch(error){if(this.current()&&!this.denied(error))this.update({phase:'unknown',errorCode:'HISTORY_SETTINGS_UNCERTAIN'});}finally{this.running=false;if(this.current())this.update({busy:false});}
 }
 dispose(){if(this.disposed)return;this.disposed=true;this.lifetime.abort();this.removeFence();this.listeners.clear();}
}
