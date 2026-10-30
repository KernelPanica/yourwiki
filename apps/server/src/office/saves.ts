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
 constructor(db:Database,store:BlobStore,ingress:OfficeIngress,options:{maxFileBytes?:number;clock?:()=>number;validator?:Validator}={}){
  this.db=db;this.store=store;this.ingress=ingress;this.validator=options.validator??new OfficeValidationWorker(db);this.journal=new SaveJournal(db,store,options);
 }
 async save(input:{lastModifiedTime:string|null;sessionId:string;token:string;lock:string;declaredSize:number|null;signal?:AbortSignal},source:AsyncIterable<Uint8Array>){
  input={...input};const received=await this.ingress.receive(input,source);
  try{return await this.ingress.withPrepared({...input,id:received.id,leaseToken:received.leaseToken},async context=>{
   const document=this.db.prepare('SELECT d.format,d.preview_job_id,v.created_at,v.size FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=? WHERE d.id=?').get(context.baseRevision,context.documentId) as {format:string;preview_job_id:string;created_at:number;size:number}|undefined;
   if(!document)throw new OfficeWriteError('NOT_FOUND');
   // Compare only with the current original. Searching historical hashes would
   // mistake an intentional Undo for a retransmission of an old save.
   if(context.blob.digest===context.baseDigest&&context.blob.size===document.size)return context.commit(()=>({
    operationId:received.id,state:'saved' as const,blob:context.blob,
    receipt:{documentId:context.documentId,revision:context.baseRevision,jobId:document.preview_job_id,blob:context.blob},
    delivery:'local' as const,providerDelivery:'not_attempted' as const,
   }));
   const time=new Date(document.created_at).toISOString();
   // Unlocked zero-byte creation is the sole WOPI exception. A forced save
   // without a precondition must retain recovery, not overwrite changed bytes.
   if(!sameTimestamp(input.lastModifiedTime,time)&&!(input.lastModifiedTime===null&&document.size===0&&context.baseRevision===1))throw new OfficeWriteError('CONFLICT',undefined,received.id);
   await this.validator.validate(context.store,context.blob,document.format,context.signal);context.assertCurrent();
   const blob=await this.store.adopt(context.store,context.blob,{signal:context.signal});context.assertCurrent();
   await this.journal.stagePrepared({operationId:received.id,userId:context.userId,documentId:context.documentId,officeSessionId:input.sessionId,baseRevision:context.baseRevision,baseDigest:context.baseDigest,blob,signal:context.signal});
   // A retained staged save must continue to fence other editor paths after expiry.
   // Do not replace another participant's existing recovery pointer.
   this.db.prepare("UPDATE office_sessions SET pending_operation_id=? WHERE id=? AND pending_operation_id IS NULL AND EXISTS(SELECT 1 FROM office_ingress WHERE id=? AND state='prepared')").run(received.id,input.sessionId,received.id);
   context.assertCurrent();
   return context.commit(()=>this.journal.commit(context.userId,received.id));
  });}catch(error){
   if(error instanceof OfficeWriteError)throw error;
   throw new OfficeWriteError(error instanceof OfficeError||error instanceof DocumentError?error.code:'OFFICE_SAVE_INTERRUPTED',undefined,received.id);
  }
 }
}
