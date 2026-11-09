import {supportsGoogleBinary} from '../providers/google-markdown-write.ts';
import type {Database} from '../database.ts';
import type {BlobStore,BlobRef} from '../storage/blobs.ts';
import {DocumentError} from '../documents.ts';
import {OfficeError} from './errors.ts';
import {SaveJournal} from '../save-journal.ts';
import {OfficeIngress,OfficeWriteError} from './ingress.ts';
import {OfficeValidationWorker} from './validation-worker.ts';
function sameTimestamp(value:string|null,canonical:string){
 if(typeof value!=='string')return false;
 const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|\+00:00)$/.exec(value);
 if(!match||match[1]!==canonical.slice(0,19))return false;const fraction=match[2]??'';
 return fraction.padEnd(3,'0').slice(0,3)===canonical.slice(20,23)&&/^0*$/.test(fraction.slice(3));
}
type Validator={validate:(store:BlobStore,blob:BlobRef,format:string,signal:AbortSignal)=>Promise<unknown>};
/** Internal local-save pipeline with pinned Collabora timestamp preconditions. */
export class OfficeSaves {
 private db:Database;private store:BlobStore;private ingress:OfficeIngress;private validator:Validator;private journal:SaveJournal;
 constructor(db:Database,store:BlobStore,ingress:OfficeIngress,options:{maxFileBytes?:number;maxPendingBytes?:number;clock?:()=>number;validator?:Validator}={}){
  this.db=db;this.store=store;this.ingress=ingress;this.validator=options.validator??new OfficeValidationWorker(db);this.journal=new SaveJournal(db,store,options);
 }
 private committed<T extends {receipt:{revision:number}|null}>(id:string,result:T){
  if(!result.receipt||this.db.prepare("UPDATE office_ingress SET committed_revision=? WHERE id=? AND state='prepared'").run(result.receipt.revision,id).changes!==1)throw new OfficeWriteError('OFFICE_SAVE_INTERRUPTED',undefined,id);return result;
 }
 async save(input:{clientTag?:string;lastModifiedTime:string|null;sessionId:string;token:string;lock:string;declaredSize:number|null;signal?:AbortSignal},source:AsyncIterable<Uint8Array>){
  input={...input};const received=await this.ingress.receive(input,source);
  try{return await this.ingress.withPrepared({...input,id:received.id,leaseToken:received.leaseToken},async context=>{
   const document=this.db.prepare('SELECT d.format,d.preview_job_id,v.created_at,v.size FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=? WHERE d.id=?').get(context.baseRevision,context.documentId) as {format:string;preview_job_id:string;created_at:number;size:number}|undefined;
   if(!document)throw new OfficeWriteError('NOT_FOUND');
   // Compare only with the current original. Searching historical hashes would
   // mistake an intentional Undo for a retransmission of an old save.
   const transformed=this.db.prepare("SELECT 1 FROM office_prepared p JOIN office_sessions s ON s.prepared_id=p.id WHERE s.id=? AND p.document_id=? AND p.source_revision=? AND p.source_digest=? AND p.format=? AND p.state='ready' AND p.digest=? AND p.size=?").get(input.sessionId,context.documentId,context.baseRevision,context.baseDigest,document.format,context.blob.digest,context.blob.size);
   if(context.blob.digest===context.baseDigest&&context.blob.size===document.size||transformed)return context.commit(()=>this.committed(received.id,{
    operationId:received.id,state:'saved' as const,blob:{digest:context.baseDigest,size:document.size},
    receipt:{documentId:context.documentId,revision:context.baseRevision,jobId:document.preview_job_id,blob:{digest:context.baseDigest,size:document.size}},
    delivery:'local' as const,providerDelivery:'not_attempted' as const,
   }));
   if(document.format==='md'&&this.db.prepare("SELECT 1 FROM office_prepared p JOIN office_sessions s ON s.prepared_id=p.id WHERE s.id=? AND p.source_digest!=p.digest").get(input.sessionId))throw new OfficeWriteError('UNSUPPORTED_OFFICE_FORMAT',undefined,received.id);
   const time=new Date(document.created_at).toISOString();
   // Unlocked zero-byte creation is the sole WOPI exception. A forced save
   // without a precondition must retain recovery, not overwrite changed bytes.
   if(!sameTimestamp(input.lastModifiedTime,time)&&!(input.lastModifiedTime===null&&document.size===0&&context.baseRevision===1))throw new OfficeWriteError('CONFLICT',undefined,received.id);
   await this.validator.validate(context.store,context.blob,document.format,context.signal);context.assertCurrent();
   const binding=this.db.prepare("SELECT b.fingerprint FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=? AND c.provider='google'").get(context.documentId) as {fingerprint:string}|undefined;
   if(binding&&!supportsGoogleBinary(document.format,binding.fingerprint))throw new OfficeWriteError('SOURCE_SAVE_UNSUPPORTED',undefined,received.id);
   const blob=await this.store.adopt(context.store,context.blob,{signal:context.signal});context.assertCurrent();
   await this.journal.stagePrepared({operationId:received.id,userId:context.userId,documentId:context.documentId,officeSessionId:input.sessionId,baseRevision:context.baseRevision,baseDigest:context.baseDigest,blob,signal:context.signal});
   // A retained staged save must continue to fence other editor paths after expiry.
   // Do not replace another participant's existing recovery pointer.
   this.db.prepare("UPDATE office_sessions SET pending_operation_id=? WHERE id=? AND pending_operation_id IS NULL AND EXISTS(SELECT 1 FROM office_ingress WHERE id=? AND state='prepared')").run(received.id,input.sessionId,received.id);
   context.assertCurrent();
   return context.commit(()=>this.committed(received.id,this.journal.commit(context.userId,received.id)));
  });}catch(error){
   if(error instanceof OfficeWriteError)throw error;
   throw new OfficeWriteError(error instanceof OfficeError||error instanceof DocumentError?error.code:'OFFICE_SAVE_INTERRUPTED',undefined,received.id);
  }
 }
}
