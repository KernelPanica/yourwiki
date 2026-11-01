import {AccessService} from '../access.ts';
import {DocumentService,DocumentError} from '../documents.ts';
import {transaction,readTransaction,type Database} from '../database.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {JobQueue} from '../jobs.ts';
export type SourceDeliveryStatus={documentId:string;kind:'source';state:'local_only'|'pending'|'sending'|'confirmed'|'unknown'|'retryable'|'conflict'|'blocked';localRevision:number;providerRevision:number|null;operationId:string|null;errorCode:string|null};
type Attempt={id:string;revision:number;state:string;error_code:string|null;connection_revision:number;lease_job_id:string;lease_until:number};
const codes=['PROVIDER_UNKNOWN','PROVIDER_UNAVAILABLE','PROVIDER_CONFLICT','PROVIDER_CONFIG_CHANGED','PROVIDER_SOURCE_CHANGED','ACCESS_DENIED'];
function invalid():never{throw new DocumentError('INVALID_REQUEST');}
function operation(value:unknown):value is string{return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);}
export function deliveryInput(value:unknown,check=false):{operationId:string;baseLocalRevision:number;requestId?:string}{
 if(!value||typeof value!=='object'||Array.isArray(value))invalid();const input=value as Record<string,unknown>,keys=check?['operationId','baseLocalRevision','requestId']:['operationId','baseLocalRevision'];if(Object.keys(input).length!==keys.length||Object.keys(input).some(k=>!keys.includes(k))||!operation(input.operationId)||!Number.isSafeInteger(input.baseLocalRevision)||Number(input.baseLocalRevision)<1||check&&!operation(input.requestId))invalid();
 return {operationId:input.operationId,baseLocalRevision:input.baseLocalRevision as number,...(check?{requestId:input.requestId as string}:{})};
}
/** DB-only metadata and explicit queue intents. Never owns credentials or contacts providers. */
export class SourceDelivery {
 private db:Database;private docs:DocumentService;private access:AccessService;private queue:JobQueue;private clock:()=>number;
 constructor(db:Database,store:BlobStore,options:{clock?:()=>number}={}){this.db=db;this.docs=new DocumentService(db,store);this.access=new AccessService(db);this.queue=new JobQueue(db);this.clock=options.clock??Date.now;}
 private document(user:string,id:string,write=false){if(!this.docs.processingStatus(user,id))throw new DocumentError('NOT_FOUND');if(write&&!this.access.allows(user,id,'write'))throw new DocumentError('ACCESS_DENIED');return this.db.prepare('SELECT local_revision,provider_revision FROM documents WHERE id=?').get(id) as {local_revision:number;provider_revision:number|null};}
 private unresolved(id:string){return this.db.prepare("SELECT id,revision,state,error_code,connection_revision,lease_job_id,lease_until FROM provider_delivery_attempts WHERE document_id=? AND state NOT IN ('confirmed','retired')").get(id) as Attempt|undefined;}
 private job(id:string){return this.db.prepare('SELECT kind,state,lease_until,error_code FROM jobs WHERE id=?').get(id) as {kind:string;state:string;lease_until:number|null;error_code:string|null}|undefined;}
 status(user:string,id:string):SourceDeliveryStatus{return readTransaction(this.db,()=>{
  const doc=this.document(user,id),base={documentId:id,kind:'source' as const,localRevision:doc.local_revision,providerRevision:doc.provider_revision,operationId:null,errorCode:null};
  const binding=this.db.prepare('SELECT b.confirmed_revision,c.enabled FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=?').get(id) as {confirmed_revision:number;enabled:number}|undefined;
  if(!binding)return {...base,state:'local_only'};const attempt=this.unresolved(id),now=this.clock();
  if(attempt){let state=attempt.state;const job=this.job(attempt.lease_job_id);if(state==='prepared')state='pending';if(state==='writing')state=attempt.lease_until>now&&job?.state==='running'&&Number(job.lease_until)>now?'sending':'unknown';const errorCode=attempt.error_code&&codes.includes(attempt.error_code)?attempt.error_code:state==='unknown'?'PROVIDER_UNKNOWN':null;return {...base,state:state as SourceDeliveryStatus['state'],operationId:attempt.id,errorCode};}
  if(doc.provider_revision===doc.local_revision&&binding.confirmed_revision===doc.local_revision)return {...base,state:'confirmed'};
  if(!binding.enabled)return {...base,state:'blocked',errorCode:'PROVIDER_CONFIG_CHANGED'};
  const pending=this.db.prepare("SELECT state,error_code FROM jobs WHERE id=(SELECT delivery_job_id FROM provider_delivery_requests WHERE document_id=?)").get(id) as {state:string;error_code:string|null}|undefined;
  return {...base,state:pending?.state==='failed'?'blocked':'pending',errorCode:pending?.state==='failed'?(pending.error_code&&codes.includes(pending.error_code)?pending.error_code:'PROVIDER_UNAVAILABLE'):null};
 });}
 private event(id:string,now:number){this.db.prepare("INSERT INTO events(kind,document_id,payload,created_at) VALUES('provider.source-delivery',?,'{}',?)").run(id,now);}
 retry(user:string,id:string,value:unknown):SourceDeliveryStatus{return transaction(this.db,()=>{
  const doc=this.document(user,id,true),input=deliveryInput(value);if(input.baseLocalRevision!==doc.local_revision)throw new DocumentError('CONFLICT');
  const prior=this.db.prepare('SELECT id,state,connection_revision FROM provider_delivery_attempts WHERE id=? AND document_id=?').get(input.operationId,id) as {id:string;state:string;connection_revision:number}|undefined;
  const key=`${id}:${doc.local_revision}:retry:${input.operationId}`;
  if(prior?.state==='retired'&&this.db.prepare("SELECT 1 FROM jobs WHERE kind='provider.deliver' AND dedupe_key=?").get(key))return this.status(user,id);
  const active=this.unresolved(id);if(!prior||prior.state!=='retryable'||active?.id!==prior.id)throw new DocumentError('CONFLICT');
  const binding=this.db.prepare('SELECT c.enabled,c.revision FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=?').get(id) as any;if(!binding?.enabled||binding.revision!==prior.connection_revision)throw new DocumentError('CONFLICT');
  const now=this.clock();this.db.prepare("UPDATE provider_delivery_attempts SET state='retired',updated_at=? WHERE id=?").run(now,prior.id);const job=this.queue.enqueue({kind:'provider.deliver',key,payload:{documentId:id,requestedRevision:doc.local_revision}},now);this.db.prepare('UPDATE provider_delivery_requests SET delivery_job_id=?,updated_at=? WHERE document_id=?').run(job,now,id);this.event(id,now);return this.status(user,id);
 });}
 check(user:string,id:string,value:unknown):SourceDeliveryStatus{return transaction(this.db,()=>{
  const doc=this.document(user,id,true),input=deliveryInput(value,true),active=this.unresolved(id),now=this.clock();if(doc.local_revision!==input.baseLocalRevision||!active||active.id!==input.operationId||!['unknown','writing'].includes(active.state))throw new DocumentError('CONFLICT');
  const current=this.job(active.lease_job_id),running=active.lease_until>now&&current?.state==='running'&&Number(current.lease_until)>now;
  if(active.state==='writing'&&running)throw new DocumentError('CONFLICT');
  // Coalesce repeated clicks with a queued/running read-back; never start another write.
  if(current?.state==='queued'&&current.kind==='provider.reconcile'&&active.state==='unknown'||running)return this.status(user,id);
  const job=this.queue.enqueue({kind:'provider.reconcile',key:`${active.id}:check:${input.requestId}`,payload:{documentId:id,requestedRevision:active.revision,operationId:active.id}},now);
  this.db.prepare("UPDATE provider_delivery_attempts SET state='unknown',error_code='PROVIDER_UNKNOWN',lease_job_id=?,lease_token='',lease_until=?,updated_at=? WHERE id=?").run(job,now,now,active.id);this.event(id,now);return this.status(user,id);
 });}
}
