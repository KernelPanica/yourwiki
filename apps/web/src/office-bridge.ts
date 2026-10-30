type Frame={postMessage:(message:string,origin:string)=>void};
type Options={origin:string;frame:Frame;write:boolean;exportAllowed:boolean;exportFormat:'docx'|'xlsx'|'pptx'};
export type OfficeSnapshot={phase:'loading'|'ready'|'modified'|'conflict'|'paused';loaded:boolean;write:boolean;exportAllowed:boolean;engineModified:boolean;needsRecovery:boolean;leaveRequested:boolean;errorCode:string|null};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** Trusted-frame protocol only. Engine modified=false is deliberately not a local-save receipt. */
export class OfficeBridge {
 private options:Options;private disposed=false;private listeners=new Set<(state:OfficeSnapshot)=>void>();private state:OfficeSnapshot;
 constructor(options:Options){
  const url=new URL(options.origin);if(!['http:','https:'].includes(url.protocol)||url.origin!==options.origin||url.username||url.password||!['docx','xlsx','pptx'].includes(options.exportFormat))throw new Error('INVALID_OFFICE_ORIGIN');
  this.options={...options};this.state={phase:'loading',loaded:false,write:options.write,exportAllowed:options.exportAllowed,engineModified:false,needsRecovery:false,leaveRequested:false,errorCode:null};
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
   this.update({engineModified:values.Modified,needsRecovery:this.state.needsRecovery||values.Modified,...(this.state.phase==='conflict'?{}:values.Modified?{phase:'modified' as const}:{})});return true;
  }
  if(message.MessageId==='UI_Close'){this.update({leaveRequested:true});return true;}
  // Save responses need correlation with a durable host receipt in the save controller.
  // Unsolicited success must never clear changes, including after a later edit.
  return false;
 }
 status(value:unknown){
  if(this.disposed||this.state.phase==='paused'||!record(value)||!['changed','expired','write','export'].every(key=>typeof value[key]==='boolean')||!(value.errorCode===null||typeof value.errorCode==='string'&&/^[A-Z_]{1,64}$/.test(value.errorCode)))return false;
  const denied=this.state.write&&value.write===false,conflict=value.changed===true||value.expired===true||!!value.errorCode||denied;
  this.update({write:this.state.write&&value.write===true,exportAllowed:this.state.exportAllowed&&value.export===true,...(conflict?{phase:'conflict' as const,needsRecovery:this.state.needsRecovery||this.state.write,errorCode:typeof value.errorCode==='string'?value.errorCode:value.expired?'OFFICE_EXPIRED':denied?'ACCESS_DENIED':'CONFLICT'}:{})});return true;
 }
 exportCurrent(){if(!this.state.loaded||!this.state.exportAllowed||this.state.phase==='paused')return false;return this.post('Action_Export',{Format:this.options.exportFormat});}
 pause(reason:string){if(this.disposed)return;this.update({phase:'paused',errorCode:/^[A-Z_]{1,64}$/.test(reason)?reason:'SESSION_REQUIRED',needsRecovery:this.state.needsRecovery||this.state.write,write:false,exportAllowed:false});}
 cancelLeave(){if(!this.disposed)this.update({leaveRequested:false});}
 dispose(){this.disposed=true;this.listeners.clear();}
}
