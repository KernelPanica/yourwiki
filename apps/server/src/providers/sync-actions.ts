import {transaction,readTransaction,type Database} from '../database.ts';
import {AccessService} from '../access.ts';
import {DocumentService,DocumentError} from '../documents.ts';
import type {SessionIdentity} from '../auth/sessions.ts';
import {JobQueue,type ClaimedJob} from '../jobs.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {providerOriginContext} from './version-origins.ts';
export type SyncActionKind='check'|'apply'|'discard';
type Input={requestId:string;baseLocalRevision:number;snapshotId:string|null};
export type SyncActionRow={id:string;document_id:string;kind:SyncActionKind;author_id:string;session_hash:string;base_local_revision:number;base_provider_revision:number;snapshot_id:string|null;connection_revision:number;binding_generation:number;job_id:string;state:'queued'|'done'|'refused';error_code:string|null};
export type SyncActionTicket={requestId:string;documentId:string;action:SyncActionKind;state:SyncActionRow['state'];errorCode:string|null};
type TicketRow=Pick<SyncActionRow,'id'|'document_id'|'kind'|'state'|'error_code'>;
const publicCodes=['SESSION_REQUIRED','ACCESS_DENIED','NOT_FOUND','CONFLICT','OFFICE_ACTIVE','SAVE_PENDING','PROVIDER_CONFIG_CHANGED','PROVIDER_SOURCE_CHANGED','PROVIDER_CONFLICT','PROVIDER_UNAVAILABLE','INGRESS_QUOTA','INGRESS_INTERRUPTED'];
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function input(value:unknown):Input{if(!value||typeof value!=='object'||Array.isArray(value))throw new DocumentError('INVALID_REQUEST');const row=value as Record<string,unknown>,keys=['requestId','baseLocalRevision','snapshotId'];if(Object.keys(row).length!==3||Object.keys(row).some(key=>!keys.includes(key))||!uuid(row.requestId)||!Number.isSafeInteger(row.baseLocalRevision)||Number(row.baseLocalRevision)<1||row.snapshotId!==null&&!uuid(row.snapshotId))throw new DocumentError('INVALID_REQUEST');return {requestId:row.requestId,baseLocalRevision:Number(row.baseLocalRevision),snapshotId:row.snapshotId as string|null};}
/** Durable explicit intents only. No provider IO or source/snapshot mutation during admission. */
export class SyncActions {
 private db:Database;private docs:DocumentService;private access:AccessService;private queue:JobQueue;private clock:()=>number;
 constructor(db:Database,store:BlobStore,options:{clock?:()=>number}={}){this.db=db;this.docs=new DocumentService(db,store);this.access=new AccessService(db);this.queue=new JobQueue(db);this.clock=options.clock??Date.now;}
 private actor(user:string,hash:string){if(!this.db.prepare('SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND u.active=1 AND u.auth_version=s.auth_version').get(hash,user,this.clock()))throw new DocumentError('SESSION_REQUIRED');}
 private document(user:string,id:string){if(!this.docs.processingStatus(user,id))throw new DocumentError('NOT_FOUND');if(!this.access.allows(user,id,'write'))throw new DocumentError('ACCESS_DENIED');return providerOriginContext(this.db,id);}
 private ticket(row:TicketRow):SyncActionTicket{return {requestId:row.id,documentId:row.document_id,action:row.kind,state:row.state,errorCode:row.error_code===null?null:publicCodes.includes(row.error_code)?row.error_code:'PROVIDER_UNAVAILABLE'};}
 status(user:string,documentId:string,requestId:string):SyncActionTicket{return readTransaction(this.db,()=>{if(!this.docs.processingStatus(user,documentId))throw new DocumentError('NOT_FOUND');if(!uuid(requestId))throw new DocumentError('INVALID_REQUEST');const row=this.db.prepare('SELECT id,document_id,kind,state,error_code FROM provider_sync_actions WHERE id=? AND document_id=?').get(requestId,documentId) as TicketRow|undefined;if(!row)throw new DocumentError('NOT_FOUND');return this.ticket(row);});}
 active(user:string,documentId:string):SyncActionTicket|null{return readTransaction(this.db,()=>{if(!this.docs.processingStatus(user,documentId))throw new DocumentError('NOT_FOUND');const row=this.db.prepare("SELECT id,document_id,kind,state,error_code FROM provider_sync_actions WHERE document_id=? AND state='queued'").get(documentId) as TicketRow|undefined;return row?this.ticket(row):null;});}
 request(actor:SessionIdentity,documentId:string,kind:SyncActionKind,value:unknown):SyncActionTicket{
  return transaction(this.db,()=>{
   this.actor(actor.userId,actor.tokenHash);const doc=this.document(actor.userId,documentId),body=input(value);if(!['check','apply','discard'].includes(kind))throw new DocumentError('INVALID_REQUEST');
   const prior=this.db.prepare('SELECT * FROM provider_sync_actions WHERE id=?').get(body.requestId) as SyncActionRow|undefined;
   if(prior){if(prior.document_id!==documentId||prior.kind!==kind||prior.author_id!==actor.userId||prior.session_hash!==actor.tokenHash||prior.base_local_revision!==body.baseLocalRevision||prior.snapshot_id!==body.snapshotId)throw new DocumentError('OPERATION_MISMATCH');return this.ticket(prior);}
   if(doc.local_revision!==body.baseLocalRevision)throw new DocumentError('CONFLICT');
   const binding=this.db.prepare('SELECT c.enabled,c.revision,b.generation FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=?').get(documentId) as {enabled:number;revision:number;generation:number}|undefined;
   if(!binding||doc.provider_revision===null||kind!=='discard'&&!binding.enabled)throw new DocumentError('PROVIDER_CONFIG_CHANGED');
   const snapshot=this.db.prepare('SELECT id,state,base_local_revision,base_provider_revision FROM provider_ingress_snapshots WHERE document_id=? ORDER BY generation DESC LIMIT 1').get(documentId) as {id:string;state:string;base_local_revision:number;base_provider_revision:number}|undefined;
   if((snapshot&&snapshot.state!=='discarded'?snapshot.id:null)!==body.snapshotId)throw new DocumentError('CONFLICT');
   if(kind!=='check'&&(!snapshot||body.snapshotId===null||!['pending','receiving','staged','conflict','failed','discarding'].includes(snapshot.state)))throw new DocumentError('CONFLICT');
   if(kind==='apply'&&(!['staged','conflict'].includes(snapshot!.state)||doc.local_revision!==doc.provider_revision||snapshot!.base_local_revision!==doc.local_revision||snapshot!.base_provider_revision!==doc.provider_revision))throw new DocumentError('CONFLICT');
   if(this.db.prepare("SELECT 1 FROM provider_sync_actions WHERE document_id=? AND state='queued'").get(documentId))throw new DocumentError('SYNC_ACTION_PENDING');
   const now=this.clock(),jobId=this.queue.enqueue({kind:'provider.pull',key:`${documentId}:action:${body.requestId}`,payload:{documentId}},now);
   this.db.prepare("INSERT INTO provider_sync_actions(id,document_id,kind,author_id,session_hash,base_local_revision,base_provider_revision,snapshot_id,connection_revision,binding_generation,job_id,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?)").run(body.requestId,documentId,kind,actor.userId,actor.tokenHash,doc.local_revision,doc.provider_revision,body.snapshotId,binding.revision,binding.generation,jobId,now);
   const previous=this.db.prepare('SELECT sequence FROM provider_sync_checks WHERE document_id=?').get(documentId) as {sequence:number}|undefined;
   this.db.prepare('INSERT INTO provider_sync_checks VALUES(?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET sequence=excluded.sequence,due_at=excluded.due_at,job_id=excluded.job_id').run(documentId,(previous?.sequence??0)+1,now+30000,jobId);
   this.db.prepare("INSERT INTO events(kind,document_id,payload,created_at) VALUES('provider.ingress',?,'{}',?)").run(documentId,now);
   return this.ticket(this.db.prepare('SELECT * FROM provider_sync_actions WHERE id=?').get(body.requestId) as SyncActionRow);
  });
 }
 forJob(job:ClaimedJob):SyncActionRow|undefined{return this.db.prepare('SELECT * FROM provider_sync_actions WHERE job_id=?').get(job.id) as SyncActionRow|undefined;}
 finish(job:ClaimedJob,errorCode?:string):void{
  const allowed=['SESSION_REQUIRED','ACCESS_DENIED','NOT_FOUND','CONFLICT','OFFICE_ACTIVE','SAVE_PENDING','PROVIDER_CONFIG_CHANGED','PROVIDER_SOURCE_CHANGED','PROVIDER_CONFLICT','PROVIDER_UNAVAILABLE','INGRESS_QUOTA','INGRESS_INTERRUPTED'];
  if(!this.queue.owns(job,this.clock()))throw new DocumentError('LEASE_LOST');const row=this.forJob(job);if(!row||row.state!=='queued')return;
  const code=errorCode===undefined?null:allowed.includes(errorCode)?errorCode:'PROVIDER_UNAVAILABLE';
  this.db.prepare('UPDATE provider_sync_actions SET state=?,error_code=?,completed_at=? WHERE id=?').run(code?'refused':'done',code,this.clock(),row.id);
  this.db.prepare("INSERT INTO events(kind,document_id,payload,created_at) VALUES('provider.ingress',?,'{}',?)").run(row.document_id,this.clock());
 }
 /** Worker-only current capability check. A queued request is not lasting write authority. */
 authorize(job:ClaimedJob,workingSnapshot?:string):SyncActionRow{
  if(!this.queue.owns(job,this.clock()))throw new DocumentError('LEASE_LOST');
  const row=this.db.prepare('SELECT * FROM provider_sync_actions WHERE job_id=?').get(job.id) as SyncActionRow|undefined;if(!row||row.state!=='queued'||job.kind!=='provider.pull'||job.payload.documentId!==row.document_id||Object.keys(job.payload).length!==1)throw new DocumentError('INVALID_REQUEST');
  this.actor(row.author_id,row.session_hash);const doc=this.document(row.author_id,row.document_id);if(doc.local_revision!==row.base_local_revision||doc.provider_revision!==row.base_provider_revision)throw new DocumentError('CONFLICT');
  const latest=this.db.prepare('SELECT id,state,lease_job_id,lease_token,lease_until,base_local_revision,base_provider_revision,connection_revision,binding_generation FROM provider_ingress_snapshots WHERE document_id=? ORDER BY generation DESC LIMIT 1').get(row.document_id) as {id:string;state:string;lease_job_id:string;lease_token:string;lease_until:number;base_local_revision:number;base_provider_revision:number;connection_revision:number;binding_generation:number}|undefined;if((latest&&latest.state!=='discarded'?latest.id:null)!==row.snapshot_id&&!(row.kind==='check'&&workingSnapshot===latest?.id&&latest?.lease_job_id===job.id&&(latest?.lease_token===job.token||latest!.lease_until<=this.clock())&&latest?.base_local_revision===row.base_local_revision&&latest?.base_provider_revision===row.base_provider_revision&&latest?.connection_revision===row.connection_revision&&latest?.binding_generation===row.binding_generation))throw new DocumentError('CONFLICT');
  const binding=this.db.prepare('SELECT c.enabled,c.revision,b.generation FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=?').get(row.document_id) as {enabled:number;revision:number;generation:number};
  if(!binding||binding.revision!==row.connection_revision||binding.generation!==row.binding_generation||row.kind!=='discard'&&!binding.enabled)throw new DocumentError('PROVIDER_CONFIG_CHANGED');return {...row};
 }
}

/** Called only for each of the scheduler's bounded known-document batch, within its metadata transaction. */
export function recoverSyncAction(db:Database,documentId:string,now:number):void{
 if(!db.inTransaction)throw new Error('Sync action recovery requires a transaction');
 const row=db.prepare("SELECT a.id,a.job_id,j.error_code FROM provider_sync_actions a JOIN jobs j ON j.id=a.job_id WHERE a.document_id=? AND a.state='queued' AND j.state='failed'").get(documentId) as {id:string;job_id:string;error_code:string|null}|undefined;if(!row)return;
 const applied=db.prepare("SELECT 1 FROM provider_ingress_snapshots WHERE lease_job_id=? AND document_id=? AND state='applied' ORDER BY generation DESC LIMIT 1").get(row.job_id,documentId);
 const codes=['SESSION_REQUIRED','ACCESS_DENIED','NOT_FOUND','CONFLICT','OFFICE_ACTIVE','SAVE_PENDING','PROVIDER_CONFIG_CHANGED','PROVIDER_SOURCE_CHANGED','PROVIDER_CONFLICT','PROVIDER_UNAVAILABLE','INGRESS_QUOTA','INGRESS_INTERRUPTED'];
 const code=applied?null:row.error_code&&codes.includes(row.error_code)?row.error_code:'PROVIDER_UNAVAILABLE';
 db.prepare('UPDATE provider_sync_actions SET state=?,error_code=?,completed_at=? WHERE id=?').run(applied?'done':'refused',code,now,row.id);
 db.prepare("INSERT INTO events(kind,document_id,payload,created_at) VALUES('provider.ingress',?,'{}',?)").run(documentId,now);
}
