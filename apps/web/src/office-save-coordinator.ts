import {api,ApiError} from './api.ts';
import {blockSession,onSessionBlocked,sessionSnapshot,sessionIsCurrent} from './session-fence.ts';
import type {OfficeBridge} from './office-bridge.ts';
type Options={bridge:OfficeBridge;sessionId:string;accessToken:string;csrf:string;request?:(url:string,init?:RequestInit)=>Promise<unknown>;autoSave?:boolean;debounceMs?:number;pollMs?:number;ackWaitMs?:number;onSessionLost?:()=>void;onError?:(error:unknown)=>void};
/** One intent/write in flight. Uncertain writes are reconciled by GET, never blindly replayed. */
export class OfficeSaveCoordinator {
 private options:Options;private request:NonNullable<Options['request']>;private generation:number;private lifetime=new AbortController();private disposed=false;private issuing=false;private polling=false;private failures=0;private startedAt=0;
 private debounce:ReturnType<typeof setTimeout>|undefined;private pollTimer:ReturnType<typeof setTimeout>|undefined;private removeBridge:()=>void;private removeFence:()=>void;
 constructor(options:Options){
  if(!options.sessionId||options.sessionId.length>128||!/^[A-Za-z0-9_-]{43}$/.test(options.accessToken)||!options.csrf||!Number.isSafeInteger(options.ackWaitMs??60000)||(options.ackWaitMs??60000)<10||(options.ackWaitMs??60000)>3600000||![options.debounceMs??750,options.pollMs??500].every(n=>Number.isSafeInteger(n)&&n>=10&&n<=60000))throw new Error('INVALID_OFFICE_SAVE_OPTIONS');
  this.options={...options};this.request=options.request??api;this.generation=sessionSnapshot().generation;
  this.removeBridge=options.bridge.subscribe(()=>this.changed());this.removeFence=onSessionBlocked(()=>{options.bridge.pause('SESSION_REQUIRED');this.stopIO();});this.changed();
 }
 private current(){return !this.disposed&&!this.lifetime.signal.aborted&&sessionIsCurrent(this.generation);}
 private clearDebounce(){if(this.debounce!==undefined){clearTimeout(this.debounce);this.debounce=undefined;}}
 private clearPoll(){if(this.pollTimer!==undefined){clearTimeout(this.pollTimer);this.pollTimer=undefined;}}
 private stopIO(){this.clearDebounce();this.clearPoll();this.lifetime.abort();}
 private changed(){
  if(!this.current())return;const state=this.options.bridge.snapshot();
  if(!this.options.bridge.pendingSave())this.clearPoll();
  if(this.options.autoSave===false||this.issuing||this.options.bridge.pendingSave()||state.phase!=='modified'||!state.loaded||!state.write||!state.needsRecovery){this.clearDebounce();return;}
  this.clearDebounce();this.debounce=setTimeout(()=>{this.debounce=undefined;void this.saveNow();},this.options.debounceMs??750);
 }
 private timedOut(){if(performance.now()-this.startedAt<(this.options.ackWaitMs??60000))return false;this.options.bridge.saveFailed('OFFICE_SAVE_UNCERTAIN');this.clearPoll();return true;}
 private schedulePoll(delay:number){if(!this.current()||!this.options.bridge.pendingSave())return;this.clearPoll();this.pollTimer=setTimeout(()=>{this.pollTimer=undefined;void this.checkNow();},delay);}
 private report(error:unknown){try{this.options.onError?.(error);}catch{/* Diagnostics must not disable recovery. */}}
 private error(error:unknown,checking:boolean){
  if(!this.current())return;this.report(error);const code=error instanceof ApiError?error.code:'NETWORK_ERROR';
  if(code==='SESSION_REQUIRED'){blockSession();this.options.onSessionLost?.();return;}
  if(['ACCESS_DENIED','NOT_FOUND'].includes(code)){this.options.bridge.pause(code);this.clearPoll();return;}
  this.options.bridge.saveFailed(code);
  if(checking&&!this.timedOut()&&!['OFFICE_SAVE_INTENT_EXPIRED','CONFLICT','OFFICE_EXPIRED','CSRF_REJECTED','INVALID_REQUEST'].includes(code))this.schedulePoll(Math.min(15000,(this.options.pollMs??500)*2**Math.min(++this.failures,5)));
 }
 async saveNow(){
  if(!this.current()||this.issuing)return;this.clearDebounce();
  if(this.options.bridge.pendingSave()){await this.checkNow();return;}
  const state=this.options.bridge.snapshot();if(!state.loaded||!state.write||!state.needsRecovery||['failed','conflict','paused'].includes(state.phase))return;
  this.issuing=true;
  try{
   const intent=await this.request(`/api/office/${encodeURIComponent(this.options.sessionId)}/save-intents`,{method:'POST',signal:this.lifetime.signal,headers:{'content-type':'application/json','x-csrf-token':this.options.csrf},body:JSON.stringify({accessToken:this.options.accessToken})});
   if(!this.current())return;const ticket=this.options.bridge.beginSave(intent);if(!ticket){if(!this.options.bridge.pendingSave())this.options.bridge.saveFailed('INVALID_SAVE_INTENT');return;}this.startedAt=performance.now();await this.checkNow();
  }catch(error){this.error(error,false);}finally{this.issuing=false;this.changed();}
 }
 async checkNow(){
  if(!this.current()||this.polling)return;this.clearPoll();const ticket=this.options.bridge.pendingSave(),state=this.options.bridge.snapshot();if(!ticket||['conflict','paused'].includes(state.phase))return;
  this.polling=true;
  try{
   const proof=await this.request(`/api/office/${encodeURIComponent(this.options.sessionId)}/save-intents/${encodeURIComponent(ticket.tag)}`,{signal:this.lifetime.signal});
   if(!this.current()||this.options.bridge.pendingSave()?.tag!==ticket.tag)return;const result=this.options.bridge.acceptProof(proof);this.failures=0;
   if(result==='pending'){if(!this.timedOut())this.schedulePoll(this.options.pollMs??500);}else if(result==='invalid')this.options.bridge.saveFailed('INVALID_SAVE_RECEIPT');
  }catch(error){this.error(error,true);}finally{this.polling=false;this.changed();}
 }
 dispose(){if(this.disposed)return;this.disposed=true;this.stopIO();this.removeBridge();this.removeFence();}
}
