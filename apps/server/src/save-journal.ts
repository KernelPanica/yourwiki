import {AccessService} from './access.ts';
import {transaction,type Database} from './database.ts';
import {DocumentService,DocumentError} from './documents.ts';
import type {BlobStore,BlobRef} from './storage/blobs.ts';
type Input={officeSessionId?:string;operationId:string;userId:string;documentId:string;baseRevision:number;baseDigest:string;blob:BlobRef};
type Receipt={documentId:string;revision:number;jobId:string;blob:BlobRef};
type Row={cancelled_at:number|null;office_session_id:string|null;id:string;document_id:string;author_id:string;base_revision:number;base_digest:string;digest:string;size:number;state:'staged'|'saved'|'conflict'|'denied';receipt:string|null};
/** Internal only: an untrusted caller must never select arbitrary private BlobRefs. */
export class SaveJournal {
 private db:Database;private store:BlobStore;private access:AccessService;private documents:DocumentService;
 private globalBytes:number;private authorBytes:number;private maxBytes:number;private clock:()=>number;
 constructor(db:Database,store:BlobStore,options:{maxFileBytes?:number;maxPendingBytes?:number;maxAuthorPendingBytes?:number;clock?:()=>number}={}){
  this.db=db;this.store=store;this.access=new AccessService(db);this.maxBytes=options.maxFileBytes??4*1024**3;
  this.globalBytes=options.maxPendingBytes??16*1024**3;this.authorBytes=options.maxAuthorPendingBytes??8*1024**3;this.clock=options.clock??Date.now;
  if(![this.maxBytes,this.globalBytes,this.authorBytes].every(value=>Number.isSafeInteger(value)&&value>0))throw new Error('Invalid save journal limits');
  this.documents=new DocumentService(db,store,{maxBytes:this.maxBytes,clock:this.clock});
 }
 private row(id:string){return this.db.prepare('SELECT * FROM save_operations WHERE id=?').get(id) as Row|undefined;}
 private readable(userId:string,documentId:string){if(!this.documents.processingStatus(userId,documentId))throw new DocumentError('NOT_FOUND');}
 private result(row:Row){return {operationId:row.id,state:row.cancelled_at!==null?'discarded' as const:row.state,blob:{digest:row.digest,size:row.size},receipt:row.receipt?JSON.parse(row.receipt) as Receipt:null,delivery:'local' as const,providerDelivery:'not_attempted' as const};}
 status(userId:string,operationId:string){
  const row=this.row(operationId);if(!row||row.author_id!==userId)throw new DocumentError('NOT_FOUND');this.readable(userId,row.document_id);return this.result(row);
 }
 private matching(row:Row,input:Input){
  if(row.author_id!==input.userId||row.document_id!==input.documentId)throw new DocumentError('NOT_FOUND');
  if(row.office_session_id!==(input.officeSessionId??null)||row.base_revision!==input.baseRevision||row.base_digest!==input.baseDigest||row.digest!==input.blob.digest||row.size!==input.blob.size)throw new DocumentError('OPERATION_MISMATCH');
  this.readable(input.userId,input.documentId);this.officeIntent(input);return this.result(row);
 }
 private officeIntent(input:Input){
  const intent=this.db.prepare('SELECT state,author_id,document_id,office_session_id,base_revision,base_digest,digest,size FROM office_ingress WHERE id=?').get(input.operationId) as {state:string;author_id:string;document_id:string;office_session_id:string;base_revision:number;base_digest:string;digest:string|null;size:number|null}|undefined;
  if(!intent)return;if(intent.author_id!==input.userId)throw new DocumentError('NOT_FOUND');
  if(intent.document_id!==input.documentId||intent.office_session_id!==input.officeSessionId)throw new DocumentError('OPERATION_MISMATCH');
  if(intent.state==='discarded')throw new DocumentError('SAVE_DISCARDED');
  if(intent.base_revision!==input.baseRevision||intent.base_digest!==input.baseDigest||intent.digest!==input.blob.digest||intent.size!==input.blob.size)throw new DocumentError('OPERATION_MISMATCH');
  if(!['prepared','committed'].includes(intent.state))throw new DocumentError('OFFICE_NOT_PREPARED');
 }
 private baseMatches(row:Pick<Row,'document_id'|'base_revision'|'base_digest'>){
  const version=this.db.prepare('SELECT d.local_revision,v.digest FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision WHERE d.id=?').get(row.document_id) as {local_revision:number;digest:string}|undefined;
  return version?.local_revision===row.base_revision&&version.digest===row.base_digest;
 }
 async stagePrepared(value:Input){
  const input={...value,blob:{...value.blob}};
  if(![input.operationId,input.userId,input.documentId].every(value=>typeof value==='string'&&value.length>0&&value.length<=128)||!/^[a-zA-Z0-9_-]{8,128}$/.test(input.operationId)||!Number.isSafeInteger(input.baseRevision)||input.baseRevision<1||!(/^[a-f0-9]{64}$/).test(input.baseDigest)||!(/^[a-f0-9]{64}$/).test(input.blob.digest)||!Number.isSafeInteger(input.blob.size)||input.blob.size<0||input.blob.size>this.maxBytes)throw new DocumentError('INVALID_REQUEST');
  const previous=this.row(input.operationId);if(previous)return this.matching(previous,input);
  this.readable(input.userId,input.documentId);this.officeIntent(input);
  if(!this.access.allows(input.userId,input.documentId,'write'))throw new DocumentError('ACCESS_DENIED');
  if(!await this.store.verify(input.blob))throw new DocumentError('INVALID_PAYLOAD');
  return transaction(this.db,()=>{
   this.officeIntent(input);const previous=this.row(input.operationId);if(previous)return this.matching(previous,input);
   const quota=this.db.prepare("SELECT COALESCE(SUM(size),0) AS total,COALESCE(SUM(CASE WHEN author_id=? THEN size ELSE 0 END),0) AS author,COUNT(*) AS count,COALESCE(SUM(CASE WHEN author_id=? THEN 1 ELSE 0 END),0) AS authorCount FROM save_operations WHERE state!='saved' AND cancelled_at IS NULL").get(input.userId,input.userId) as {total:number;author:number;count:number;authorCount:number};
   if(input.blob.size>this.globalBytes-quota.total||input.blob.size>this.authorBytes-quota.author||quota.count>=10000||quota.authorCount>=1000)throw new DocumentError('PENDING_LIMIT');
   const allowed=this.access.allows(input.userId,input.documentId,'write');
   const state=!allowed?'denied':this.baseMatches({document_id:input.documentId,base_revision:input.baseRevision,base_digest:input.baseDigest})?'staged':'conflict';
   this.db.prepare('INSERT INTO save_operations(id,document_id,author_id,base_revision,base_digest,digest,size,state,created_at,updated_at,office_session_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(input.operationId,input.documentId,input.userId,input.baseRevision,input.baseDigest,input.blob.digest,input.blob.size,state,this.clock(),this.clock(),input.officeSessionId??null);
   return this.result(this.row(input.operationId)!);
  });
 }
 commit(userId:string,operationId:string){
  try{return transaction(this.db,()=>{
   const row=this.row(operationId);if(!row||row.author_id!==userId)throw new DocumentError('NOT_FOUND');
   this.readable(userId,row.document_id);this.officeIntent({operationId:row.id,userId,documentId:row.document_id,officeSessionId:row.office_session_id??undefined,baseRevision:row.base_revision,baseDigest:row.base_digest,blob:{digest:row.digest,size:row.size}});if(row.cancelled_at!==null)throw new DocumentError('SAVE_DISCARDED');if(row.state==='saved')return this.result(row);
   if(row.state==='conflict')throw new DocumentError('CONFLICT');
   if(row.state==='denied'||!this.access.allows(userId,row.document_id,'write'))throw new DocumentError('ACCESS_DENIED');
   if(!this.baseMatches(row))throw new DocumentError('CONFLICT');
   const receipt=this.documents.commitPreparedSave({userId,documentId:row.document_id,baseRevision:row.base_revision,officeSessionId:row.office_session_id??undefined},{digest:row.digest,size:row.size});
   if(row.office_session_id){
    const updated=this.db.prepare(`UPDATE office_sessions SET base_revision=?,base_digest=?,
     pending_operation_id=CASE WHEN pending_operation_id=? THEN NULL ELSE pending_operation_id END,
     error_code=CASE WHEN pending_operation_id IS NULL OR pending_operation_id=? THEN NULL ELSE error_code END
     WHERE id=? AND document_id=? AND base_revision=? AND base_digest=? AND superseded=0 AND expires_at>?`).run(receipt.revision,receipt.blob.digest,row.id,row.id,row.office_session_id,row.document_id,row.base_revision,row.base_digest,this.clock());
    if(updated.changes!==1)throw new DocumentError('CONFLICT');
   }
   this.db.prepare("UPDATE save_operations SET state='saved',receipt=?,updated_at=? WHERE id=?").run(JSON.stringify(receipt),this.clock(),row.id);
   this.db.prepare("INSERT INTO events(kind,document_id,payload,created_at) VALUES('save.local.committed',?,?,?)").run(row.document_id,JSON.stringify({revision:receipt.revision}),this.clock());
   return this.result(this.row(row.id)!);
  });}catch(error){
   if(error instanceof DocumentError&&['CONFLICT','ACCESS_DENIED','NOT_FOUND'].includes(error.code)){
    // A separate transaction records failure without rolling back the retained payload.
    this.db.prepare("UPDATE save_operations SET state=?,updated_at=? WHERE id=? AND author_id=? AND state='staged'").run(error.code==='CONFLICT'?'conflict':'denied',this.clock(),operationId,userId);
   }
   throw error;
  }
 }
}
