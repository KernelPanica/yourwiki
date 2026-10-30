import {api,ApiError} from './api.ts';
import {OfficeBridge} from './office-bridge.ts';
import {OfficeSaveCoordinator} from './office-save-coordinator.ts';
import {blockSession,onSessionBlocked,sessionIsCurrent,sessionSnapshot} from './session-fence.ts';
import type {Language} from './i18n.ts';
type Frame=ConstructorParameters<typeof OfficeBridge>[0]['frame'];
export type OfficeBootstrap={sessionId:string;accessToken:string;expiresAt:number;write:boolean;export:boolean;actionUrl:string};
export type OfficeConnectionSnapshot={phase:'idle'|'opening'|'open'|'failed'|'paused'|'closing'|'closed';bootstrap:OfficeBootstrap|null;errorCode:string|null};
type Options={documentId:string;csrf:string;language:Language;format:'docx'|'xlsx'|'pptx';request?:(url:string,init?:RequestInit)=>Promise<unknown>;statusMs?:number;now?:()=>number;onSessionLost?:()=>void};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function parseOfficeBootstrap(value:unknown):OfficeBootstrap {
 try{
  if(!record(value)||typeof value.sessionId!=='string'||!/^[-A-Za-z0-9_]{1,128}$/.test(value.sessionId)||typeof value.accessToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.accessToken)||!Number.isSafeInteger(value.expiresAt)||Number(value.expiresAt)<=0||typeof value.write!=='boolean'||typeof value.export!=='boolean'||typeof value.actionUrl!=='string'||value.actionUrl.length>16384)throw 0;
  const url=new URL(value.actionUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||[...url.searchParams.keys()].some(key=>/^(access_token|access_token_ttl)$/i.test(key))||url.searchParams.getAll('WOPISrc').length!==1)throw 0;
  const source=new URL(url.searchParams.get('WOPISrc')!);if(!['http:','https:'].includes(source.protocol)||source.username||source.password||source.search||source.hash||!source.pathname.endsWith(`/wopi/files/${value.sessionId}`))throw 0;
  return {sessionId:value.sessionId,accessToken:value.accessToken,expiresAt:Number(value.expiresAt),write:value.write,export:value.export,actionUrl:value.actionUrl};
 }catch{throw new ApiError('INVALID_OFFICE_BOOTSTRAP');}
}
/** Owns one iframe capability. Call close() and await true before unmounting a live frame. */
export class OfficeConnection {
 private options:Options;private request:NonNullable<Options['request']>;private generation:number;private lifetime=new AbortController();private disposed=false;
 private state:OfficeConnectionSnapshot={phase:'idle',bootstrap:null,errorCode:null};private listeners=new Set<()=>void>();private opening:Promise<void>|undefined;private closing:Promise<boolean>|undefined;
 private statusTimer:ReturnType<typeof setTimeout>|undefined;private checking=false;private frame:Frame|undefined;private removeFence:()=>void;
 bridge:OfficeBridge|undefined;save:OfficeSaveCoordinator|undefined;
 constructor(options:Options){
  if(!options.documentId||options.documentId.length>128||!options.csrf||!['ru','en','es'].includes(options.language)||!['docx','xlsx','pptx'].includes(options.format)||!Number.isSafeInteger(options.statusMs??5000)||(options.statusMs??5000)<10||(options.statusMs??5000)>60000)throw new Error('INVALID_OFFICE_CONNECTION');
  this.options={...options};this.request=options.request??api;this.generation=sessionSnapshot().generation;
  this.removeFence=onSessionBlocked(()=>{this.stopStatus();this.lifetime.abort();this.save?.dispose();this.bridge?.pause('SESSION_REQUIRED');this.update({phase:'paused',errorCode:'SESSION_REQUIRED'});});
 }
 snapshot():OfficeConnectionSnapshot{return {...this.state,bootstrap:this.state.bootstrap?{...this.state.bootstrap}:null};}
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private update(value:Partial<OfficeConnectionSnapshot>){if(this.disposed)return;this.state={...this.state,...value};for(const listener of [...this.listeners]){try{listener();}catch{/* View errors cannot restore a capability. */}}}
 private current(){return !this.disposed&&!this.lifetime.signal.aborted&&sessionIsCurrent(this.generation);}
 private stopStatus(){clearTimeout(this.statusTimer);this.statusTimer=undefined;}
 private expire(){if(!this.state.bootstrap||this.state.bootstrap.expiresAt>(this.options.now??Date.now)())return false;this.stopStatus();this.save?.dispose();this.bridge?.status({changed:false,expired:true,write:false,export:false,errorCode:'OFFICE_EXPIRED'});this.update({phase:'paused',errorCode:'OFFICE_EXPIRED'});return true;}
 private scheduleStatus(){this.stopStatus();if(this.current()&&this.state.phase==='open')this.statusTimer=setTimeout(()=>{this.statusTimer=undefined;void this.check();},this.options.statusMs??5000);}
 private failed(error:unknown){
  if(!this.current())return;const code=error instanceof ApiError?error.code:'NETWORK_ERROR';
  if(code==='SESSION_REQUIRED'){blockSession();this.options.onSessionLost?.();return;}
  if(['ACCESS_DENIED','NOT_FOUND'].includes(code)){this.bridge?.pause(code);this.stopStatus();this.update({phase:'paused'});}else this.bridge?.saveFailed(code);
  this.update({errorCode:code,...(!this.state.bootstrap?{phase:'failed' as const}:{})});
 }
 open(){
  if(this.opening)return this.opening;if(!this.current()||this.state.phase!=='idle')return Promise.resolve();this.update({phase:'opening',errorCode:null});
  this.opening=(async()=>{try{
   const value=await this.request(`/api/documents/${encodeURIComponent(this.options.documentId)}/office`,{method:'POST',signal:this.lifetime.signal,headers:{'content-type':'application/json','x-csrf-token':this.options.csrf},body:JSON.stringify({language:this.options.language})});
   if(!this.current()||this.state.phase!=='opening')return;const bootstrap=parseOfficeBootstrap(value);if(bootstrap.expiresAt<=(this.options.now??Date.now)())throw new ApiError('OFFICE_EXPIRED');this.update({phase:'open',bootstrap});
  }catch(error){this.failed(error);}})();return this.opening;
 }
 attach(frame:Frame){
  if(!this.current()||this.state.phase!=='open'||!this.state.bootstrap)throw new Error('OFFICE_NOT_OPEN');
  if(this.expire())throw new ApiError('OFFICE_EXPIRED');
  if(this.bridge){if(frame!==this.frame)throw new Error('OFFICE_FRAME_CHANGED');return this.bridge;}
  this.frame=frame;const opened=this.state.bootstrap;
  this.bridge=new OfficeBridge({origin:new URL(opened.actionUrl).origin,frame,write:opened.write,exportAllowed:opened.export,exportFormat:this.options.format});
  this.save=new OfficeSaveCoordinator({bridge:this.bridge,sessionId:opened.sessionId,accessToken:opened.accessToken,csrf:this.options.csrf,request:this.request,onSessionLost:this.options.onSessionLost});this.scheduleStatus();return this.bridge;
 }
 receive(event:{origin:string;source:unknown;data:unknown}){return this.current()&&this.state.phase==='open'?(this.bridge?.receive(event)??false):false;}
 async check():Promise<boolean>{
  if(!this.current()||this.checking||this.state.phase!=='open'||!this.state.bootstrap||!this.bridge)return false;
  this.stopStatus();if(this.expire())return false;this.checking=true;const id=this.state.bootstrap.sessionId;
  try{
   const value=await this.request(`/api/office/${encodeURIComponent(id)}/status`,{method:'POST',signal:this.lifetime.signal,headers:{'x-csrf-token':this.options.csrf}});
   if(!this.current()||this.state.phase!=='open')return false;
   if(!record(value)||value.sessionId!==id||value.documentId!==this.options.documentId||typeof value.recovery!=='boolean'||!this.bridge.status(value))throw new ApiError('INVALID_OFFICE_STATUS');
   this.update({errorCode:this.bridge.snapshot().errorCode});return true;
  }catch(error){if(this.state.phase==='open')this.failed(error);return false;}finally{this.checking=false;this.scheduleStatus();}
 }
 async exportCurrent(){if(!await this.check()||!this.current()||this.state.phase!=='open')return false;return this.bridge?.exportCurrent()??false;}
 close(){
  if(this.closing)return this.closing;if(this.state.phase==='closed')return Promise.resolve(true);if(!this.current())return Promise.resolve(false);
  // A pending bootstrap may still create a capability. Do not claim it is safe to unmount.
  if(!this.state.bootstrap)return Promise.resolve(this.state.phase!=='opening');
  this.stopStatus();this.save?.dispose();this.bridge?.saveFailed('OFFICE_CLOSING');this.update({phase:'closing',errorCode:null});const opened=this.state.bootstrap;
  const closing=(async()=>{try{
   await this.request(`/api/office/${encodeURIComponent(opened.sessionId)}/release`,{method:'POST',signal:this.lifetime.signal,headers:{'content-type':'application/json','x-csrf-token':this.options.csrf},body:JSON.stringify({accessToken:opened.accessToken})});
   if(!this.current())return false;this.bridge?.dispose();this.update({phase:'closed',errorCode:null});return true;
  }catch(error){if(this.current()){if(error instanceof ApiError&&error.code==='NOT_FOUND'){this.bridge?.dispose();this.update({phase:'closed',errorCode:null});return true;}this.failed(error);if(this.current())this.update({phase:'failed',errorCode:'OFFICE_RELEASE_UNCERTAIN'});}return false;}})();
  this.closing=closing;void closing.finally(()=>{if(this.closing===closing)this.closing=undefined;});return closing;
 }
 /** Final teardown only; this does not prove server-side revocation. */
 dispose(){if(this.disposed)return;this.disposed=true;this.stopStatus();this.lifetime.abort();this.save?.dispose();this.bridge?.dispose();this.removeFence();this.listeners.clear();}
}
