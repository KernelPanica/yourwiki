import {randomUUID} from 'node:crypto';
import {transaction,type Database} from '../database.ts';
import {BlobStore,type BlobRef} from '../storage/blobs.ts';
import {OfficeSessions,OfficeError} from './sessions.ts';
import {OfficeValidationWorker} from './validation-worker.ts';
export const officeTransitVersion='office-transit-v2';
type Row={id:string;document_id:string;source_revision:number;source_digest:string;format:string;converter_version:string;state:string;digest:string|null;size:number|null;reserved_bytes:number;lease_token:string;lease_until:number;last_access_at:number};
type Worker={prepare:(source:BlobStore,blob:BlobRef,format:string,target:BlobStore,signal:AbortSignal,limits:{maxOutputBytes:number})=>Promise<BlobRef>};
/** Derived private bytes only. Original revisions remain the authority for conflict detection. */
export class OfficePrepared {
 private db:Database;private store:BlobStore;private office:OfficeSessions;private worker:Worker;private clock:()=>number;private maxFile:number;private maxPending:number;
 private active=new Map<string,AbortController>();private pending=new Set<Promise<unknown>>();private closed=false;private closing:Promise<void>|undefined;private cleaning:Promise<number>|undefined;
 constructor(db:Database,store:BlobStore,options:{maxFileBytes?:number;maxPendingBytes?:number;clock?:()=>number;worker?:Worker}={}){
  this.db=db;this.store=store;this.clock=options.clock??Date.now;this.office=new OfficeSessions(db,{clock:this.clock});this.worker=options.worker??new OfficeValidationWorker(db);this.maxFile=options.maxFileBytes??4*1024**3;this.maxPending=options.maxPendingBytes??8*1024**3;
  if(![this.maxFile,this.maxPending].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('Invalid office preparation limits');
 }
 private source(sessionId:string,token:string){
  const actor=this.office.authorize(sessionId,token);if(actor.session.superseded)throw new OfficeError('CONFLICT');
  const version=this.db.prepare('SELECT d.format,v.digest,v.size FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=? WHERE d.id=?').get(actor.session.base_revision,actor.session.document_id) as {format:string;digest:string;size:number}|undefined;
  if(!version||version.digest!==actor.session.base_digest)throw new OfficeError('CONFLICT');return {sessionId,documentId:actor.session.document_id,revision:actor.session.base_revision,...version};
 }
 private row(id:string){return this.db.prepare('SELECT * FROM office_prepared WHERE id=?').get(id) as Row|undefined;}
 private cached(source:ReturnType<OfficePrepared['source']>){
  const pinned=this.db.prepare("SELECT p.* FROM office_prepared p JOIN office_sessions s ON s.prepared_id=p.id WHERE s.id=? AND p.document_id=? AND p.source_revision=? AND p.source_digest=? AND p.format=?").get(source.sessionId,source.documentId,source.revision,source.digest,source.format) as Row|undefined;if(pinned){if(pinned.state==='ready')return pinned;if(pinned.converter_version!==officeTransitVersion)throw new OfficeError('OFFICE_PREPARED_MISSING');}
  return this.db.prepare("SELECT * FROM office_prepared WHERE document_id=? AND source_revision=? AND source_digest=? AND format=? AND converter_version=? AND state IN ('creating','ready')").get(source.documentId,source.revision,source.digest,source.format,officeTransitVersion) as Row|undefined;
 }
 private receipt(row:Row){return {id:row.id,documentId:row.document_id,sourceRevision:row.source_revision,sourceDigest:row.source_digest,format:row.format,converterVersion:row.converter_version,blob:{digest:row.digest!,size:row.size!}};}
 get(sessionId:string,token:string){return transaction(this.db,()=>{const source=this.source(sessionId,token),row=this.cached(source);if(!row||row.state!=='ready')throw new OfficeError('OFFICE_PREPARING');this.db.prepare('UPDATE office_prepared SET last_access_at=? WHERE id=?').run(this.clock(),row.id);this.db.prepare('UPDATE office_sessions SET prepared_id=? WHERE id=?').run(row.id,sessionId);return this.receipt(row);});}
 async payload(sessionId:string,token:string){
  const receipt=this.get(sessionId,token);
  const missing=()=>{transaction(this.db,()=>{this.db.prepare("UPDATE office_prepared SET state='failed',error_code='OFFICE_PREPARED_MISSING' WHERE id=? AND state='ready' AND digest=?").run(receipt.id,receipt.blob.digest);if(receipt.converterVersion!==officeTransitVersion)this.db.prepare("UPDATE office_sessions SET superseded=1,error_code='OFFICE_PREPARED_MISSING' WHERE id=? AND prepared_id=?").run(sessionId,receipt.id);});throw new OfficeError('OFFICE_PREPARED_MISSING');};
  const store=await this.store.existingUploadStore(receipt.id);if(!store)return missing();
  let blob:BlobRef;try{blob=await store.stat(receipt.blob.digest);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return missing();throw error;}
  if(blob.size!==receipt.blob.size)return missing();const current=this.get(sessionId,token);if(current.id!==receipt.id)throw new OfficeError('CONFLICT');return {receipt,store};
 }
 prepare(sessionId:string,token:string,signal:AbortSignal){
  if(this.closed)return Promise.reject(new OfficeError('OFFICE_CLOSED'));const work=this.run(sessionId,token,signal);this.pending.add(work);work.then(()=>this.pending.delete(work),()=>this.pending.delete(work));return work;
 }
 private async run(sessionId:string,token:string,parent:AbortSignal){
  parent.throwIfAborted();const warm=transaction(this.db,()=>{const row=this.cached(this.source(sessionId,token));return row?.state==='ready'?this.get(sessionId,token):null;});if(warm)return warm;await this.cleanup();if(this.closed)throw new OfficeError('OFFICE_CLOSED');parent.throwIfAborted();
  const context=transaction(this.db,()=>{
   const source=this.source(sessionId,token),existing=this.cached(source);if(existing?.state==='ready')return {source,row:existing,ready:true};if(existing)throw new OfficeError('OFFICE_PREPARING');if(source.size>this.maxFile)throw new OfficeError('PAYLOAD_TOO_LARGE');
   const bound=source.format==='md'?Math.min(this.maxFile,16*1024**2):this.maxFile;
   const quota=this.db.prepare("SELECT COALESCE(SUM(reserved_bytes),0) AS bytes,COUNT(*) AS n,COALESCE(SUM(CASE WHEN state='creating' THEN 1 ELSE 0 END),0) AS active FROM office_prepared WHERE reserved_bytes>0 OR state IN ('creating','ready')").get() as {bytes:number;n:number;active:number};
   if(bound>this.maxPending-quota.bytes||quota.n>=1000||quota.active>=15)throw new OfficeError('OFFICE_PREPARED_QUOTA');
   const id=randomUUID(),lease=randomUUID(),now=this.clock();this.db.prepare("INSERT INTO office_prepared(id,document_id,source_revision,source_digest,format,converter_version,state,reserved_bytes,lease_token,lease_until,created_at,last_access_at) VALUES(?,?,?,?,?,?,'creating',?,?,?,?,?)").run(id,source.documentId,source.revision,source.digest,source.format,officeTransitVersion,bound,lease,now+30000,now,now);return {source,row:this.row(id)!,ready:false};
  });if(context.ready)return this.get(sessionId,token);
  const {row,source}=context,controller=new AbortController(),signal=AbortSignal.any([parent,controller.signal]);this.active.set(row.id,controller);
  const check=()=>{
   signal.throwIfAborted();const current=this.row(row.id);if(current?.state!=='creating'||current.lease_token!==row.lease_token||current.lease_until<=this.clock())throw new OfficeError('OFFICE_PREPARED_LEASE_LOST');
   const original=this.source(sessionId,token);if(original.documentId!==source.documentId||original.revision!==source.revision||original.digest!==source.digest||original.format!==source.format)throw new OfficeError('CONFLICT');
  };
  const heartbeat=setInterval(()=>{try{transaction(this.db,()=>{check();this.db.prepare('UPDATE office_prepared SET lease_until=? WHERE id=? AND lease_token=?').run(this.clock()+30000,row.id,row.lease_token);});}catch(error){controller.abort(error);}},10000),deadline=setTimeout(()=>controller.abort(new OfficeError('OFFICE_PREPARATION_TIMEOUT')),120000);
  try{
   const target=await this.store.uploadStore(row.id);check();const result=await this.worker.prepare(this.store,{digest:source.digest,size:source.size},source.format,target,signal,{maxOutputBytes:row.reserved_bytes});const prepared={...result};check();
   if(!Number.isSafeInteger(prepared.size)||prepared.size<0||prepared.size>row.reserved_bytes||!await target.verify(prepared,signal))throw new OfficeError('INVALID_OFFICE_FILE');
   return transaction(this.db,()=>{check();this.db.prepare("UPDATE office_prepared SET state='ready',digest=?,size=?,reserved_bytes=?,error_code=NULL,last_access_at=? WHERE id=? AND lease_token=?").run(prepared.digest,prepared.size,prepared.size,this.clock(),row.id,row.lease_token);return this.get(sessionId,token);});
  }catch(error){
   this.db.prepare("UPDATE office_prepared SET state='failed',error_code=? WHERE id=? AND lease_token=? AND state='creating'").run(error instanceof OfficeError?error.code:'OFFICE_PREPARATION_FAILED',row.id,row.lease_token);throw error;
  }finally{clearInterval(heartbeat);clearTimeout(deadline);this.active.delete(row.id);}
 }
 cleanup(){if(this.closed)return Promise.resolve(0);return this.cleaning??=this.clean().finally(()=>{this.cleaning=undefined;});}
 private eligible(row:Row){return row.state==='failed'||['creating','deleting'].includes(row.state)&&row.lease_until<=this.clock()||row.state==='ready'&&row.last_access_at<this.clock()-86400000&&!this.db.prepare('SELECT 1 FROM office_sessions WHERE prepared_id=? AND (expires_at>? OR pending_operation_id IS NOT NULL)').get(row.id,this.clock());}
 private async clean(){
  for(const [id,controller] of this.active){const row=this.row(id);if(row&&row.lease_until<=this.clock())controller.abort(new OfficeError('OFFICE_PREPARED_LEASE_LOST'));}
  const ids=new Set((this.db.prepare("SELECT id FROM office_prepared WHERE (state IN ('creating','deleting') AND lease_until<=?) OR (state='failed' AND reserved_bytes>0) OR (state='ready' AND last_access_at<?) LIMIT 32").all(this.clock(),this.clock()-86400000) as {id:string}[]).map(row=>row.id));
  for await(const id of this.store.uploadNamespaces()){if(this.closed)break;const row=this.row(id);if(row&&this.eligible(row))ids.add(id);if(ids.size>=64)break;}
  let cleaned=0;for(const id of ids){if(this.closed)break;const token=randomUUID(),row=transaction(this.db,()=>{const row=this.row(id);if(!row||!this.eligible(row))return null;this.db.prepare("UPDATE office_prepared SET state='deleting',lease_token=?,lease_until=? WHERE id=?").run(token,this.clock()+120000,id);return row;});if(!row)continue;
   try{await this.store.removeUpload(id);transaction(this.db,()=>{const current=this.row(id);if(current?.state!=='deleting'||current.lease_token!==token||current.lease_until<=this.clock())throw new OfficeError('OFFICE_PREPARED_LEASE_LOST');this.db.prepare("UPDATE office_prepared SET state='failed',reserved_bytes=0 WHERE id=?").run(id);});cleaned++;}catch{this.db.prepare("UPDATE office_prepared SET state='failed',lease_until=0 WHERE id=? AND state='deleting' AND lease_token=?").run(id,token);/* Keep the reservation charged until physical cleanup succeeds. */}
  }return cleaned;
 }
 close(){return this.closing??=this.shutdown();}
 private async shutdown(){this.closed=true;for(const controller of this.active.values())controller.abort(new OfficeError('OFFICE_CLOSED'));await Promise.allSettled([...this.pending,this.cleaning]);}
}
