type Frame={postMessage:(message:string,origin:string)=>void};
type Options={origin:string;frame:Frame;write:boolean;exportAllowed:boolean;exportFormat:'docx'|'xlsx'|'pptx'};
export type OfficeSnapshot={phase:'loading'|'ready'|'modified'|'saving'|'saved'|'failed'|'conflict'|'paused';loaded:boolean;saving:boolean;localRevision:number|null;write:boolean;exportAllowed:boolean;engineModified:boolean;needsRecovery:boolean;leaveRequested:boolean;errorCode:string|null};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** Trusted-frame protocol only. Engine modified=false is deliberately not a local-save receipt. */
export class OfficeBridge {
 private generation=0;private pending:{tag:string;generation:number;baseRevision:number}|undefined;private proof:{revision:number;currentRevision:number}|undefined;
 private options:Options;private disposed=false;private listeners=new Set<(state:OfficeSnapshot)=>void>();private state:OfficeSnapshot;
 constructor(options:Options){
  if(typeof options.write!=='boolean'||typeof options.exportAllowed!=='boolean'||!options.frame||typeof options.frame.postMessage!=='function')throw new Error('INVALID_OFFICE_CONFIG');
  const url=new URL(options.origin);if(!['http:','https:'].includes(url.protocol)||url.origin!==options.origin||url.username||url.password||!['docx','xlsx','pptx'].includes(options.exportFormat))throw new Error('INVALID_OFFICE_ORIGIN');
  this.options={...options};this.state={phase:'loading',loaded:false,saving:false,localRevision:null,write:options.write,exportAllowed:options.exportAllowed,engineModified:false,needsRecovery:false,leaveRequested:false,errorCode:null};
 }
 snapshot(){return {...this.state};}
 subscribe(listener:(state:OfficeSnapshot)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private update(value:Partial<OfficeSnapshot>){this.state={...this.state,...value};for(const listener of [...this.listeners]){try{listener(this.snapshot());}catch{/* A failed view listener must not disable the leave guard. */}}}
 private post(MessageId:string,Values:Record<string,unknown>={}){if(this.disposed||this.state.phase==='paused')return false;this.options.frame.postMessage(JSON.stringify({MessageId,Values}),this.options.origin);return true;}
 receive(event:{source:unknown;origin:string;data:unknown}){
  if(this.disposed||this.state.phase==='paused'||event.source!==this.options.frame||event.origin!==this.options.origin)return false;
  let message:unknown=event.data;if(typeof message==='string'){if(message.length>65536)return false;try{message=JSON.parse(message);}catch{return false;}}
  if(!record(message)||!Object.hasOwn(message,'MessageId')||typeof message.MessageId!=='string')return false;
  const values=record(message.Values)?message.Values:{};
  if(message.MessageId==='App_LoadingStatus'){
   if(values.Status!=='Frame_Ready'&&values.Status!=='Document_Loaded')return false;
   this.post('Host_PostmessageReady');
   if(values.Status==='Document_Loaded')this.update({loaded:true,...(this.state.phase==='loading'?{phase:'ready' as const}:{})});return true;
  }
  if(message.MessageId==='Doc_ModifiedStatus'){
   if(typeof values.Modified!=='boolean'||!this.state.loaded||!this.state.write)return false;
   if(values.Modified)this.generation++;
   this.update({engineModified:values.Modified,needsRecovery:this.state.needsRecovery||values.Modified,...(['conflict','failed'].includes(this.state.phase)?{}:values.Modified?{phase:'modified' as const}:{})});this.finish();return true;
  }
  if(message.MessageId==='UI_Close'){this.update({leaveRequested:true});return true;}
  // Save responses need correlation with a durable host receipt in the save controller.
  // Unsolicited success must never clear changes, including after a later edit.
  return false;
 }
 status(value:unknown){
  if(this.disposed||this.state.phase==='paused'||!record(value)||!['changed','expired','write','export'].every(key=>typeof value[key]==='boolean')||!(value.errorCode===null||typeof value.errorCode==='string'&&/^[A-Z_]{1,64}$/.test(value.errorCode)))return false;
  const denied=this.state.write&&value.write===false,conflict=value.changed===true||value.expired===true||!!value.errorCode||denied;
  this.update({write:this.state.write&&value.write===true,exportAllowed:this.state.exportAllowed&&value.export===true,...(conflict?{phase:'conflict' as const,saving:false,needsRecovery:this.state.needsRecovery||this.state.write,errorCode:typeof value.errorCode==='string'?value.errorCode:value.expired?'OFFICE_EXPIRED':denied?'ACCESS_DENIED':'CONFLICT'}:{})});return true;
 }
 beginSave(value:unknown){
  if(this.disposed||this.pending||!this.state.loaded||!this.state.write||!this.state.needsRecovery||['loading','failed','conflict','paused'].includes(this.state.phase)||!record(value)||typeof value.tag!=='string'||!/^yourwiki-save-[A-Za-z0-9_-]{32}$/.test(value.tag)||!Number.isSafeInteger(value.baseRevision)||Number(value.baseRevision)<1||!Number.isSafeInteger(value.expiresAt)||Number(value.expiresAt)<1)return null;
  const ticket={tag:value.tag,generation:this.generation,baseRevision:Number(value.baseRevision)};this.pending=Object.freeze(ticket);this.proof=undefined;this.update({phase:'saving',saving:true,errorCode:null});
  try{if(!this.post('Action_Save',{Notify:true,DontSaveIfUnmodified:false,ExtendedData:ticket.tag})){this.saveFailed('OFFICE_SAVE_UNCERTAIN');return null;}}catch{this.saveFailed('OFFICE_SAVE_UNCERTAIN');return null;}
  return {...ticket};
 }
 pendingSave(){return this.pending?{...this.pending}:null;}
 acceptProof(value:unknown):'invalid'|'pending'|'saved'|'superseded'|'failed'{
  if(this.disposed||!this.pending||['conflict','paused'].includes(this.state.phase)||!record(value)||value.tag!==this.pending.tag||value.delivery!=='local'||(value.state!=='pending'&&value.state!=='saved'&&value.state!=='failed')||typeof value.changed!=='boolean'||typeof value.expired!=='boolean'||!Number.isSafeInteger(value.currentRevision)||Number(value.currentRevision)<1)return 'invalid';
  if(value.changed||value.expired){this.saveFailed(value.expired?'OFFICE_EXPIRED':'CONFLICT');return 'failed';}
  if(value.state==='failed'){this.saveFailed(typeof value.errorCode==='string'?value.errorCode:'OFFICE_SAVE_FAILED');return 'failed';}
  if(value.state==='pending')return 'pending';
  if(!Number.isSafeInteger(value.revision)||Number(value.revision)<this.pending.baseRevision||Number(value.revision)>Number(value.currentRevision)||typeof value.operationId!=='string'||value.operationId.length<1||value.operationId.length>128)return 'invalid';
  this.proof={revision:Number(value.revision),currentRevision:Number(value.currentRevision)};return this.finish();
 }
 private finish():'pending'|'saved'|'superseded'{
  if(!this.pending||!this.proof||this.disposed||['conflict','paused'].includes(this.state.phase))return 'pending';
  if(this.pending.generation!==this.generation||this.proof.currentRevision!==this.proof.revision){this.pending=undefined;this.proof=undefined;this.update({phase:'modified',saving:false,needsRecovery:true});return 'superseded';}
  if(this.state.engineModified)return 'pending';
  const revision=this.proof.revision;this.pending=undefined;this.proof=undefined;this.update({phase:'saved',saving:false,needsRecovery:false,localRevision:revision,errorCode:null});return 'saved';
 }
 saveFailed(reason:string){
  if(this.disposed||['conflict','paused'].includes(this.state.phase))return;
  const code=/^[A-Z_]{1,64}$/.test(reason)?reason:'OFFICE_SAVE_FAILED',conflict=['CONFLICT','OFFICE_EXPIRED','ACCESS_DENIED'].includes(code);
  this.update({phase:conflict?'conflict':'failed',saving:false,needsRecovery:this.state.needsRecovery||this.state.write,errorCode:code});
 }
 exportCurrent(){if(!this.state.loaded||!this.state.exportAllowed||this.state.phase==='paused')return false;return this.post('Action_Export',{Format:this.options.exportFormat});}
 pause(reason:string){if(this.disposed)return;this.update({phase:'paused',saving:false,errorCode:/^[A-Z_]{1,64}$/.test(reason)?reason:'SESSION_REQUIRED',needsRecovery:this.state.needsRecovery||this.state.write,write:false,exportAllowed:false});}
 cancelLeave(){if(!this.disposed)this.update({leaveRequested:false});}
 dispose(){this.disposed=true;this.listeners.clear();}
}
