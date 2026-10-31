import {officeRecoveryAllowed} from './recovery-access.ts';
import {OfficeIngressMaintenance} from './ingress-maintenance.ts';
import {randomUUID} from 'node:crypto';
import {OfficeSessions,OfficeError} from './sessions.ts';
import {AccessService} from '../access.ts';
import {transaction,type Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {BlobStore,BlobTooLargeError,type BlobRef} from '../storage/blobs.ts';
export class OfficeWriteError extends OfficeError {currentLock?:string;writeId?:string;constructor(code:string,currentLock?:string,writeId?:string){super(code);this.currentLock=currentLock;this.writeId=writeId;}}
type Input={clientTag?:string;sessionId:string;token:string;lock:string;declaredSize:number|null;signal?:AbortSignal};
type PreparedInput={id:string;leaseToken:string;sessionId:string;token:string;signal?:AbortSignal};
type PreparedContext={signal:AbortSignal;blob:BlobRef;store:BlobStore;userId:string;documentId:string;baseRevision:number;baseDigest:string;assertCurrent:()=>void;commit:<R>(save:()=>R)=>R};
type Row={created_at:number;id:string;document_id:string;office_session_id:string;author_id:string;base_revision:number;base_digest:string;state:string;digest:string|null;size:number|null;lease_token:string;lease_until:number;lock_value:string;reserved_bytes:number;error_code:string|null};
/** Internal bounded spool. Prepared bytes are durable but are not yet accepted as an original. */
export class OfficeIngress {
 private closed=false;private pending=new Set<Promise<unknown>>();private closing:Promise<void>|undefined;
 private active=new Map<string,AbortController>();private maintenance:OfficeIngressMaintenance;private db:Database;private store:BlobStore;private office:OfficeSessions;private clock:()=>number;private maxFile:number;private maxPending:number;
 constructor(db:Database,store:BlobStore,options:{maxFileBytes?:number;maxPendingBytes?:number;clock?:()=>number}={}){
  this.db=db;this.store=store;this.clock=options.clock??Date.now;this.maxFile=options.maxFileBytes??4*1024**3;this.maxPending=options.maxPendingBytes??8*1024**3;this.office=new OfficeSessions(db,{clock:this.clock});this.maintenance=new OfficeIngressMaintenance(db,store,this.clock);
  if(![this.maxFile,this.maxPending].every(value=>Number.isSafeInteger(value)&&value>0))throw new Error('Invalid office ingress limits');
 }
 private track<T>(task:Promise<T>){this.pending.add(task);task.then(()=>this.pending.delete(task),()=>this.pending.delete(task));return task;}
 close(){return this.closing??=this.shutdown();}
 private async shutdown(){
  this.closed=true;for(const controller of this.active.values())controller.abort(new OfficeWriteError('OFFICE_CLOSED'));
  await Promise.allSettled([this.maintenance.close(),...this.pending]);
 }
 private row(id:string){return this.db.prepare('SELECT * FROM office_ingress WHERE id=?').get(id) as Row|undefined;}
 private result(row:Row){return {createdAt:row.created_at,id:row.id,sessionId:row.office_session_id,documentId:row.document_id,userId:row.author_id,baseRevision:row.base_revision,baseDigest:row.base_digest,state:row.state,errorCode:row.error_code,blob:row.digest!==null?{digest:row.digest,size:row.size!}:null};}
 status(userId:string,id:string){const row=this.row(id);if(!row||!officeRecoveryAllowed(this.db,userId,row))throw new OfficeError('NOT_FOUND');return this.result(row);}
 recoveries(userId:string,documentId:string,cursor='',limit=50){
  if(!Number.isSafeInteger(limit)||limit<1||limit>50||cursor.length>128)throw new OfficeError('INVALID_REQUEST');
  if(!new AccessService(this.db).allows(userId,documentId,'read'))throw new OfficeError('NOT_FOUND');
  const user=this.db.prepare('SELECT admin_role FROM users WHERE id=?').get(userId) as {admin_role:string};
  const rows=this.db.prepare("SELECT * FROM office_ingress WHERE document_id=? AND id>? AND (state='receiving' OR (state IN ('prepared','failed') AND digest IS NOT NULL)) AND (?=1 OR author_id=?) ORDER BY id LIMIT ?").all(documentId,cursor,Number(user.admin_role==='giga'),userId,limit+1) as Row[];
  return {items:rows.slice(0,limit).map(row=>this.result(row)),nextCursor:rows.length>limit?rows[limit-1]!.id:null};
 }
 async payloadStore(userId:string,id:string){const status=this.status(userId,id);if(!status.blob||status.state==='discarded')throw new OfficeError('NOT_FOUND');const store=await this.store.existingUploadStore(id);if(!store)throw new OfficeError('OFFICE_RECOVERY_MISSING');return store;}
 cleanupExpired(){for(const [id,controller] of this.active){const row=this.row(id);if(row&&['receiving','prepared'].includes(row.state)&&row.lease_until<=this.clock())controller.abort(new OfficeWriteError('OFFICE_WRITE_LEASE_LOST'));}return this.maintenance.cleanupExpired();}
 async discard(userId:string,id:string){this.status(userId,id);this.active.get(id)?.abort(new OfficeWriteError('OFFICE_WRITE_DISCARDED'));return this.maintenance.discard(userId,id);}
 private owns(id:string,token:string){return !!this.db.prepare("SELECT 1 FROM office_ingress WHERE id=? AND lease_token=? AND state='receiving' AND lease_until>?").get(id,token,this.clock());}
 /** Internal continuation: only the holder of the receive receipt may process it. */
 withPrepared<T>(input:PreparedInput,operation:(context:PreparedContext)=>Promise<T>):Promise<T>{
  if(this.closed)return Promise.reject(new OfficeWriteError('OFFICE_CLOSED'));return this.track(this.processPrepared(input,operation));
 }
 private async processPrepared<T>(input:PreparedInput,operation:(context:PreparedContext)=>Promise<T>):Promise<T>{
  input={...input};input.signal?.throwIfAborted();const token=randomUUID(),controller=new AbortController();
  const signal=input.signal?AbortSignal.any([input.signal,controller.signal]):controller.signal;
  const check=(leaseToken:string)=>{
   signal.throwIfAborted();const row=this.row(input.id);
   if(row?.state==='discarded')throw new OfficeWriteError('OFFICE_WRITE_DISCARDED',undefined,input.id);
   if(!row||row.state!=='prepared'||row.lease_token!==leaseToken||row.lease_until<=this.clock()||row.office_session_id!==input.sessionId||!row.digest||row.size===null)throw new OfficeWriteError('OFFICE_WRITE_LEASE_LOST',undefined,input.id);
   const actor=this.office.authorize(input.sessionId,input.token);
   if(actor.userId!==row.author_id)throw new OfficeWriteError('NOT_FOUND');if(!actor.write)throw new OfficeWriteError('ACCESS_DENIED');
   if(actor.session.superseded||actor.session.base_revision!==row.base_revision||actor.session.base_digest!==row.base_digest)throw new OfficeWriteError('CONFLICT',undefined,input.id);
   const current=actor.session.lock_expires_at>this.clock()?actor.session.lock_value:'';
   const version=this.db.prepare('SELECT size FROM document_versions WHERE document_id=? AND revision=?').get(row.document_id,row.base_revision) as {size:number}|undefined;
   if(current?current!==row.lock_value:version?.size!==0)throw new OfficeWriteError('OFFICE_LOCK_MISMATCH',current,input.id);
   return row;
  };
  const row=transaction(this.db,()=>{const row=check(input.leaseToken);this.db.prepare('UPDATE office_ingress SET lease_token=?,lease_until=? WHERE id=?').run(token,this.clock()+30000,input.id);return row;});
  this.active.set(input.id,controller);let committed=false;
  const heartbeat=setInterval(()=>{try{transaction(this.db,()=>{check(token);this.db.prepare('UPDATE office_ingress SET lease_until=? WHERE id=? AND lease_token=?').run(this.clock()+30000,input.id,token);});}catch(error){controller.abort(error);}},10000);
  const deadline=setTimeout(()=>controller.abort(new OfficeWriteError('OFFICE_WRITE_TIMEOUT')),3600000);
  const assertCurrent=()=>{check(token);};
  try{
   const store=await this.store.existingUploadStore(input.id);assertCurrent();if(!store)throw new OfficeWriteError('OFFICE_RECOVERY_MISSING',undefined,input.id);
   const result=await operation({signal,blob:{digest:row.digest!,size:row.size!},store,userId:row.author_id,documentId:row.document_id,baseRevision:row.base_revision,baseDigest:row.base_digest,assertCurrent,
    commit:<R>(save:()=>R):R=>transaction(this.db,()=>{
     if(committed)throw new OfficeWriteError('OFFICE_ALREADY_COMMITTED');check(token);
     const result=save();if(result&&typeof (result as any).then==='function')throw new OfficeWriteError('INVALID_REQUEST');
     this.db.prepare("UPDATE office_ingress SET state='committed',error_code=NULL WHERE id=? AND lease_token=?").run(input.id,token);committed=true;return result;
    })});
   if(!committed)throw new OfficeWriteError('OFFICE_NOT_COMMITTED',undefined,input.id);return result;
  }catch(error){
   if(!committed)this.db.prepare("UPDATE office_ingress SET error_code=? WHERE id=? AND lease_token=? AND state='prepared'").run(error instanceof OfficeError||error instanceof DocumentError?error.code:'OFFICE_SAVE_INTERRUPTED',input.id,token);
   throw error;
  }finally{if(this.active.get(input.id)===controller)this.active.delete(input.id);clearInterval(heartbeat);clearTimeout(deadline);}
 }
 receive(value:Input,source:AsyncIterable<Uint8Array>){
  if(this.closed)return Promise.reject(new OfficeWriteError('OFFICE_CLOSED'));return this.track(this.receiveOne(value,source));
 }
 private async receiveOne(value:Input,source:AsyncIterable<Uint8Array>){
  const input={...value};if(input.declaredSize!==null&&(!Number.isSafeInteger(input.declaredSize)||input.declaredSize<0))throw new OfficeWriteError('INVALID_REQUEST');
  if(input.declaredSize!==null&&input.declaredSize>this.maxFile)throw new OfficeWriteError('PAYLOAD_TOO_LARGE');input.signal?.throwIfAborted();
  if(!this.office.authorize(input.sessionId,input.token).write)throw new OfficeWriteError('ACCESS_DENIED');
  await this.cleanupExpired();if(this.closed)throw new OfficeWriteError('OFFICE_CLOSED');input.signal?.throwIfAborted();
  const initial=transaction(this.db,()=>{
   const actor=this.office.authorize(input.sessionId,input.token);if(!actor.write)throw new OfficeWriteError('ACCESS_DENIED');
   const now=this.clock(),current=actor.session.lock_expires_at>now?actor.session.lock_value:'';
   const version=this.db.prepare('SELECT size FROM document_versions WHERE document_id=? AND revision=?').get(actor.session.document_id,actor.session.base_revision) as {size:number}|undefined;
   if(current?current!==input.lock:version?.size!==0)throw new OfficeWriteError('OFFICE_LOCK_MISMATCH',current);
   const budget=this.db.prepare("SELECT COALESCE(SUM(reserved_bytes),0) AS bytes,SUM(CASE WHEN state='receiving' THEN 1 ELSE 0 END) AS active,COUNT(*) AS n FROM office_ingress WHERE reserved_bytes>0 OR state IN ('receiving','prepared') OR (state='failed' AND digest IS NOT NULL)").get() as {bytes:number;active:number;n:number};
   const reserved=input.declaredSize??this.maxFile;
   if(reserved>this.maxPending-budget.bytes||budget.active>=15||budget.n>=1000)throw new OfficeWriteError('OFFICE_WRITE_QUOTA');
   if(this.db.prepare("SELECT 1 FROM office_ingress WHERE document_id=? AND state='receiving'").get(actor.session.document_id))throw new OfficeWriteError('OFFICE_WRITE_BUSY');
   const clientTag=typeof input.clientTag==='string'&&/^yourwiki-save-[A-Za-z0-9_-]{32}$/.test(input.clientTag)&&this.db.prepare('SELECT 1 FROM office_save_intents WHERE tag=? AND office_session_id=? AND expires_at>?').get(input.clientTag,input.sessionId,now)?input.clientTag:null;
   const id=randomUUID(),leaseToken=randomUUID();this.db.prepare("INSERT INTO office_ingress(id,document_id,office_session_id,author_id,base_revision,base_digest,lock_value,declared_size,reserved_bytes,state,lease_token,lease_until,created_at,client_tag) VALUES(?,?,?,?,?,?,?,?,?,'receiving',?,?,?,?)").run(id,actor.session.document_id,input.sessionId,actor.userId,actor.session.base_revision,actor.session.base_digest,input.lock,input.declaredSize,reserved,leaseToken,now+30000,now,clientTag);
   return {id,leaseToken};
  });
  const controller=new AbortController(),signal=input.signal?AbortSignal.any([input.signal,controller.signal]):controller.signal;
  this.active.set(initial.id,controller);
  const heartbeat=setInterval(()=>{
   try{if(!this.office.authorize(input.sessionId,input.token).write)throw new OfficeWriteError('ACCESS_DENIED');if(this.db.prepare("UPDATE office_ingress SET lease_until=? WHERE id=? AND lease_token=? AND lease_until>? AND state='receiving'").run(this.clock()+30000,initial.id,initial.leaseToken,this.clock()).changes!==1)controller.abort(new OfficeWriteError('OFFICE_WRITE_LEASE_LOST'));}
   catch(error){controller.abort(error);}
  },10000);
  const deadline=setTimeout(()=>controller.abort(new OfficeWriteError('OFFICE_WRITE_TIMEOUT')),3600000);
  try{
   const temporary=await this.store.uploadStore(initial.id);
   const blob=await temporary.put(source,{maxBytes:input.declaredSize??this.maxFile,signal});
   const prepared=transaction(this.db,()=>{
    if(!this.owns(initial.id,initial.leaseToken))throw new OfficeWriteError('OFFICE_WRITE_LEASE_LOST',undefined,initial.id);
    if(input.declaredSize!==null&&blob.size!==input.declaredSize){this.db.prepare("UPDATE office_ingress SET state='failed',digest=?,size=?,reserved_bytes=?,error_code='OFFICE_SIZE_MISMATCH' WHERE id=?").run(blob.digest,blob.size,blob.size,initial.id);return {error:new OfficeWriteError('OFFICE_SIZE_MISMATCH',undefined,initial.id)};}
    this.db.prepare("UPDATE office_ingress SET state='prepared',digest=?,size=?,reserved_bytes=?,lease_until=? WHERE id=?").run(blob.digest,blob.size,blob.size,this.clock()+30000,initial.id);
    return {...this.result(this.row(initial.id)!),leaseToken:initial.leaseToken};
   });
   if('error' in prepared)throw prepared.error;return prepared;
  }catch(error){
   this.db.prepare("UPDATE office_ingress SET state='failed',error_code=? WHERE id=? AND lease_token=? AND state='receiving'").run(error instanceof OfficeError?error.code:'OFFICE_UPLOAD_INTERRUPTED',initial.id,initial.leaseToken);
   const current=this.row(initial.id),cleaning=this.db.prepare('SELECT 1 FROM office_ingress_cleanup WHERE id=? AND lease_until>?').get(initial.id,this.clock());
   if(current?.digest===null&&!cleaning){await this.store.removeUpload(initial.id);this.db.prepare("UPDATE office_ingress SET reserved_bytes=0 WHERE id=? AND lease_token=? AND state='failed' AND digest IS NULL").run(initial.id,initial.leaseToken);}
   if(current?.state==='discarded')throw new OfficeWriteError('OFFICE_WRITE_DISCARDED',undefined,initial.id);
   if(current?.error_code==='OFFICE_WRITE_LEASE_LOST')throw new OfficeWriteError('OFFICE_WRITE_LEASE_LOST',undefined,initial.id);
   if(error instanceof BlobTooLargeError)throw new OfficeWriteError('PAYLOAD_TOO_LARGE',undefined,initial.id);throw error;
  }finally{this.active.delete(initial.id);clearInterval(heartbeat);clearTimeout(deadline);}
 }
}
