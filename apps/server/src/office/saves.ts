import type {Database} from '../database.ts';
import type {BlobStore,BlobRef} from '../storage/blobs.ts';
import {DocumentError} from '../documents.ts';
import {OfficeError} from './errors.ts';
import {SaveJournal} from '../save-journal.ts';
import {OfficeIngress,OfficeWriteError} from './ingress.ts';
import {OfficeValidationWorker} from './validation-worker.ts';
type Validator={validate:(store:BlobStore,blob:BlobRef,format:string,signal:AbortSignal)=>Promise<unknown>};
/** Internal local-save pipeline; HTTP timestamp/retry preconditions belong at ingress. */
export class OfficeSaves {
 private db:Database;private store:BlobStore;private ingress:OfficeIngress;private validator:Validator;private journal:SaveJournal;
 constructor(db:Database,store:BlobStore,ingress:OfficeIngress,options:{maxFileBytes?:number;clock?:()=>number;validator?:Validator}={}){
  this.db=db;this.store=store;this.ingress=ingress;this.validator=options.validator??new OfficeValidationWorker(db);this.journal=new SaveJournal(db,store,options);
 }
 async save(input:{sessionId:string;token:string;lock:string;declaredSize:number|null;signal?:AbortSignal},source:AsyncIterable<Uint8Array>){
  input={...input};const received=await this.ingress.receive(input,source);
  try{return await this.ingress.withPrepared({...input,id:received.id,leaseToken:received.leaseToken},async context=>{
   const document=this.db.prepare('SELECT format FROM documents WHERE id=?').get(context.documentId) as {format:string}|undefined;
   if(!document)throw new OfficeWriteError('NOT_FOUND');
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
