import {buffer} from 'node:stream/consumers';
import {transaction,readTransaction,type Database} from './database.ts';
import {DocumentError} from './document-errors.ts';
import {DocumentService} from './documents.ts';
import {PdfLayerService} from './pdf-layers.ts';
import {HistoryRead} from './history-read.ts';
import {HistoryIntegrity} from './history-integrity.ts';
import {officeWriteAllowed} from './office/fence.ts';
import {OfficeValidationWorker} from './office/validation-worker.ts';
import {officeFormats} from './office/formats.ts';
import {OfficeError} from './office/errors.ts';
import type {BlobStore} from './storage/blobs.ts';
export type RestoreInput={operationId:string;userId:string;documentId:string;entryId:number;baseRevision:number;baseDigest:string;layerRevision:number;layerDigest:string|null};
type Receipt={documentId:string;entryId:number;kind:'source'|'pdf-layer';revision:number;layerRevision:number;digest:string;size:number;jobId:string|null};
type Row={id:string;author_id:string;document_id:string;entry_id:number;base_revision:number;base_digest:string;layer_revision:number;layer_digest:string|null;target_digest:string;target_size:number;format:string;kind:'source'|'pdf-layer';state:'staged'|'saved'|'discarded';receipt:string|null;error_code:string|null};
type Binding=Pick<Row,'author_id'|'document_id'|'entry_id'|'base_revision'|'base_digest'|'layer_revision'|'layer_digest'|'target_digest'|'target_size'|'format'|'kind'>;
const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
/** Receipt-scoped restore; public callers can never nominate a private BlobRef. */
export class HistoryRestore{
 private db:Database;private store:BlobStore;private reader:HistoryRead;private integrity:HistoryIntegrity;private docs:DocumentService;private layers:PdfLayerService;private validator:OfficeValidationWorker;private lifetime=new AbortController();private pending=new Set<Promise<unknown>>();private maxBytes:number;
 constructor(db:Database,store:BlobStore,options:{maxFileBytes?:number}={}){this.db=db;this.store=store;this.maxBytes=options.maxFileBytes??4*1024**3;if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<1)throw new Error('Invalid restore limit');this.reader=new HistoryRead(db,store);this.integrity=new HistoryIntegrity(db);this.docs=new DocumentService(db,store,{maxBytes:this.maxBytes});this.layers=new PdfLayerService(db,store,{maxBytes:this.maxBytes});this.validator=new OfficeValidationWorker(db);}
 private row(id:string){return this.db.prepare('SELECT * FROM history_restores WHERE id=?').get(id) as Row|undefined;}
 private result(row:Row){return {operationId:row.id,documentId:row.document_id,entryId:this.reader.storageEntry(row.author_id,row.document_id,row.entry_id).item.id,state:row.state,errorCode:row.error_code,baseline:{baseRevision:row.base_revision,baseDigest:row.base_digest,layerRevision:row.layer_revision,layerDigest:row.layer_digest},receipt:row.receipt?JSON.parse(row.receipt) as Receipt:null,delivery:'local' as const,providerDelivery:'not_attempted' as const};}
 private scoped(user:string,id:string){this.lifetime.signal.throwIfAborted();const row=this.row(id);if(!row||row.author_id!==user)throw new DocumentError('NOT_FOUND');this.reader.storageEntry(user,row.document_id,row.entry_id);return row;}
 status(user:string,id:string){return readTransaction(this.db,()=>this.result(this.scoped(user,id)));}
 /** Read-only confirmation metadata. The accepted operation still rechecks this exact baseline. */
 describe(user:string,documentId:string,entryId:number){
  return readTransaction(this.db,()=>{
   const context=this.reader.resolvedEntry(user,documentId,entryId);if(!context.document.write)throw new DocumentError('ACCESS_DENIED');const entry=context.item;
   const source=this.db.prepare('SELECT d.local_revision,v.digest FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision WHERE d.id=?').get(documentId) as {local_revision:number;digest:string}|undefined;
   const layer=this.db.prepare('SELECT revision,digest FROM pdf_layer_versions WHERE document_id=? ORDER BY revision DESC LIMIT 1').get(documentId) as {revision:number;digest:string}|undefined;
   if(!source||!Number.isSafeInteger(source.local_revision)||source.local_revision<1||!digest(source.digest)||layer&&(!Number.isSafeInteger(layer.revision)||layer.revision<1||!digest(layer.digest)))throw new DocumentError('HISTORY_CORRUPT');
   const baseline={baseRevision:source.local_revision,baseDigest:source.digest,layerRevision:layer?.revision??0,layerDigest:layer?.digest??null};let blockedReason:string|null=null;
   const binding:Binding={author_id:user,document_id:documentId,entry_id:context.reference.storageId,base_revision:baseline.baseRevision,base_digest:baseline.baseDigest,layer_revision:baseline.layerRevision,layer_digest:baseline.layerDigest,target_digest:entry.sha256,target_size:entry.size,format:entry.format,kind:entry.kind};
   try{this.guard(binding);}catch(error){if(!(error instanceof DocumentError)||!['CONFLICT','HISTORY_FORMAT_MISMATCH','OFFICE_ACTIVE','SAVE_PENDING'].includes(error.code))throw error;blockedReason=error.code;}
   if(entry.size>this.maxBytes)blockedReason='PAYLOAD_TOO_LARGE';
   const format=entry.format==='markdown'?'md':entry.format==='text'?'txt':entry.format;
   if(!blockedReason&&!officeFormats.has(format)&&format!=='pdf')blockedReason='HISTORY_FORMAT_UNSUPPORTED';
   return {schemaVersion:1 as const,documentId,entry,baseline,blockedReason};
  });
 }
 request(value:RestoreInput){
  const input={...value};this.lifetime.signal.throwIfAborted();
  if(typeof input.operationId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(input.operationId)||typeof input.userId!=='string'||typeof input.documentId!=='string'||!Number.isSafeInteger(input.entryId)||input.entryId<1||!Number.isSafeInteger(input.baseRevision)||input.baseRevision<1||!digest(input.baseDigest)||!Number.isSafeInteger(input.layerRevision)||input.layerRevision<0||(input.layerRevision===0?input.layerDigest!==null:!digest(input.layerDigest)))throw new DocumentError('INVALID_REQUEST');
  return transaction(this.db,()=>{
   const previous=this.row(input.operationId);
   if(previous){this.scoped(input.userId,input.operationId);if(previous.document_id!==input.documentId||this.reader.storageEntry(input.userId,previous.document_id,previous.entry_id).item.id!==input.entryId||previous.base_revision!==input.baseRevision||previous.base_digest!==input.baseDigest||previous.layer_revision!==input.layerRevision||previous.layer_digest!==input.layerDigest)throw new DocumentError('OPERATION_MISMATCH');return this.result(previous);}
   const context=this.reader.resolvedEntry(input.userId,input.documentId,input.entryId);if(!context.document.write)throw new DocumentError('ACCESS_DENIED');const item=context.item;
   if(item.size>this.maxBytes)throw new DocumentError('PAYLOAD_TOO_LARGE');
   const row:Row={id:input.operationId,author_id:input.userId,document_id:input.documentId,entry_id:context.reference.storageId,base_revision:input.baseRevision,base_digest:input.baseDigest,layer_revision:input.layerRevision,layer_digest:input.layerDigest,target_digest:item.sha256,target_size:item.size,format:item.format,kind:item.kind,state:'staged',receipt:null,error_code:null};this.guard(row);
   const quota=this.db.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN author_id=? THEN 1 ELSE 0 END),0) AS own FROM history_restores WHERE state='staged'").get(input.userId) as {total:number;own:number};if(quota.total>=256||quota.own>=15)throw new DocumentError('PENDING_LIMIT');const now=Date.now();
   this.db.prepare("INSERT INTO history_restores(id,author_id,document_id,entry_id,base_revision,base_digest,layer_revision,layer_digest,target_digest,target_size,format,kind,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'staged',?,?)").run(row.id,row.author_id,row.document_id,row.entry_id,row.base_revision,row.base_digest,row.layer_revision,row.layer_digest,row.target_digest,row.target_size,row.format,row.kind,now,now);return this.result(row);
  });
 }
 private guard(row:Binding){
  const context=this.reader.storageEntry(row.author_id,row.document_id,row.entry_id);if(!context.document.write)throw new DocumentError('ACCESS_DENIED');const item=context.item;if(item.sha256!==row.target_digest||item.size!==row.target_size||item.format!==row.format||item.kind!==row.kind)throw new DocumentError('HISTORY_CORRUPT');
  const current=this.db.prepare('SELECT d.format,d.local_revision,v.digest FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision WHERE d.id=?').get(row.document_id) as {format:string;local_revision:number;digest:string};
  if(current.local_revision!==row.base_revision||current.digest!==row.base_digest)throw new DocumentError('CONFLICT');if(!row.format||current.format!==row.format)throw new DocumentError('HISTORY_FORMAT_MISMATCH');
  const layer=this.db.prepare('SELECT revision,digest FROM pdf_layer_versions WHERE document_id=? ORDER BY revision DESC LIMIT 1').get(row.document_id) as {revision:number;digest:string}|undefined;
  if((layer?.revision??0)!==row.layer_revision||(layer?.digest??null)!==row.layer_digest)throw new DocumentError('CONFLICT');if(row.kind==='pdf-layer'&&(row.format!=='pdf'||item.sourceRevision!==row.base_revision))throw new DocumentError('CONFLICT');
  if(!officeWriteAllowed(this.db,row.document_id,undefined,Date.now()))throw new DocumentError('OFFICE_ACTIVE');
  if(this.db.prepare("SELECT 1 FROM office_ingress WHERE document_id=? AND (state='receiving' OR (state IN ('prepared','failed') AND digest IS NOT NULL)) LIMIT 1").get(row.document_id))throw new DocumentError('SAVE_PENDING');
  if(this.db.prepare("SELECT 1 FROM save_operations WHERE document_id=? AND state!='saved' AND cancelled_at IS NULL LIMIT 1").get(row.document_id)||this.db.prepare("SELECT 1 FROM uploads WHERE state='active' AND json_extract(metadata,'$.documentId')=? AND expires_at>? LIMIT 1").get(row.document_id,Date.now()))throw new DocumentError('SAVE_PENDING');
 }
 discard(user:string,id:string){return transaction(this.db,()=>{const row=this.scoped(user,id);if(row.state==='saved')throw new DocumentError('OPERATION_MISMATCH');this.db.prepare("UPDATE history_restores SET state='discarded',error_code=NULL,updated_at=? WHERE id=?").run(Date.now(),id);return this.result(this.row(id)!);});}
 commit(user:string,id:string,options:{signal?:AbortSignal;authorize?:()=>void}={}){const task=this.run(user,id,options);this.pending.add(task);void task.then(()=>this.pending.delete(task),()=>this.pending.delete(task));return task;}
 private async run(user:string,id:string,options:{signal?:AbortSignal;authorize?:()=>void}){
  const controller=new AbortController(),signal=AbortSignal.any([this.lifetime.signal,controller.signal,...(options.signal?[options.signal]:[])]),authorize=options.authorize;signal.throwIfAborted();authorize?.();let row=this.scoped(user,id);if(row.state==='saved')return this.result(row);if(row.state==='discarded')throw new DocumentError('SAVE_DISCARDED');
  const check=()=>readTransaction(this.db,()=>{signal.throwIfAborted();authorize?.();const current=this.scoped(user,id);if(current.state==='discarded')throw new DocumentError('SAVE_DISCARDED');if(current.state!=='saved')this.guard(current);});
  const watch=setInterval(()=>{try{check();}catch(error){controller.abort(error);}},250);
  try{
   check();await this.integrity.verify(this.store,{digest:row.target_digest,size:row.target_size},signal,check);check();
   const format=row.format==='markdown'?'md':row.format==='text'?'txt':row.format;
   if(officeFormats.has(format)){try{await this.validator.validate(this.store,{digest:row.target_digest,size:row.target_size},format,signal);}catch(error){signal.throwIfAborted();if(error instanceof OfficeError)throw new DocumentError(error.code);throw error;}}
   else if(format==='pdf'){if(row.target_size<5)throw new DocumentError('INVALID_PDF');const header=await buffer(await this.store.read(row.target_digest,{start:0,end:Math.min(1023,row.target_size-1)}));if(!header.includes(Buffer.from('%PDF-')))throw new DocumentError('INVALID_PDF');}
   else throw new DocumentError('HISTORY_FORMAT_UNSUPPORTED');
   return transaction(this.db,()=>{
    check();row=this.scoped(user,id);if(row.state==='saved')return this.result(row);const blob={digest:row.target_digest,size:row.target_size};let receipt:Receipt;
    if(row.kind==='source'){const result=this.docs.commitPreparedSave({userId:user,documentId:row.document_id,baseRevision:row.base_revision,signal},blob);receipt={documentId:row.document_id,entryId:this.reader.storageEntry(row.author_id,row.document_id,row.entry_id).item.id,kind:row.kind,revision:result.revision,layerRevision:row.layer_revision,digest:blob.digest,size:blob.size,jobId:result.jobId};}
    else{const result=this.layers.commitPreparedSave({userId:user,documentId:row.document_id,baseRevision:row.base_revision,layerRevision:row.layer_revision,replaceStaleLayer:true,signal},blob);receipt={documentId:row.document_id,entryId:this.reader.storageEntry(row.author_id,row.document_id,row.entry_id).item.id,kind:row.kind,revision:result.baseRevision,layerRevision:result.layerRevision,digest:blob.digest,size:blob.size,jobId:null};}
    this.db.prepare("UPDATE history_restores SET state='saved',receipt=?,error_code=NULL,updated_at=? WHERE id=? AND state='staged'").run(JSON.stringify(receipt),Date.now(),id);this.db.prepare("INSERT INTO events(kind,document_id,payload,created_at) VALUES('history.restored',?,?,?)").run(row.document_id,JSON.stringify({entryId:this.reader.storageEntry(row.author_id,row.document_id,row.entry_id).item.id,operationId:row.id,revision:receipt.revision,layerRevision:receipt.layerRevision}),Date.now());return this.result(this.row(id)!);
   });
  }catch(error){const reason=signal.aborted?signal.reason:error;this.db.prepare("UPDATE history_restores SET error_code=?,updated_at=? WHERE id=? AND author_id=? AND state='staged'").run(reason instanceof DocumentError?reason.code:'HISTORY_INTERRUPTED',Date.now(),id,user);throw reason;}
  finally{clearInterval(watch);}
 }
 async close(){this.lifetime.abort(new DocumentError('HISTORY_CLOSED'));await Promise.allSettled([...this.pending]);await this.integrity.close();await this.reader.close();}
}
