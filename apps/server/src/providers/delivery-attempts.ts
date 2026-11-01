import {randomUUID} from 'node:crypto';
import {AccessService} from '../access.ts';
import {transaction,type Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {JobQueue,type ClaimedJob} from '../jobs.ts';
export type DeliveryState='prepared'|'writing'|'unknown'|'confirmed'|'retryable'|'conflict'|'blocked'|'retired';
export type DeliveryAttempt={id:string;documentId:string;revision:number;authorId:string;digest:string;size:number;baseline:string;baseRevision:number;bindingGeneration:number;connectionRevision:number;state:DeliveryState;job:ClaimedJob};
type AttemptRow={id:string;document_id:string;revision:number;author_id:string;digest:string;size:number;baseline:string;base_revision:number;binding_generation:number;connection_revision:number;state:DeliveryState;lease_job_id:string;lease_token:string;lease_until:number};
const leaseMs=30000;
function validTime(now:number){if(!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-leaseMs)throw new DocumentError('INVALID_REQUEST');}
function fail(code:string):never{throw new DocumentError(code);}
function decode(row:AttemptRow,job:ClaimedJob):DeliveryAttempt{return {id:row.id,documentId:row.document_id,revision:row.revision,authorId:row.author_id,digest:row.digest,size:row.size,baseline:row.baseline,baseRevision:row.base_revision,bindingGeneration:row.binding_generation,connectionRevision:row.connection_revision,state:row.state,job};}
/** Internal worker state, never an HTTP DTO. No source mutation is performed here. */
export class DeliveryAttempts {
 private db:Database;private queue:JobQueue;private access:AccessService;
 constructor(db:Database){this.db=db;this.queue=new JobQueue(db);this.access=new AccessService(db);}
 private scope(row:AttemptRow){
  if(!this.access.allows(row.author_id,row.document_id,'read')||!this.access.allows(row.author_id,row.document_id,'write'))fail('ACCESS_DENIED');
  const bound=this.db.prepare('SELECT b.fingerprint,b.confirmed_revision,b.generation,c.enabled,c.revision FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=?').get(row.document_id) as any;
  if(!bound?.enabled||bound.revision!==row.connection_revision)fail('PROVIDER_CONFIG_CHANGED');
  if(bound.fingerprint!==row.baseline||bound.confirmed_revision!==row.base_revision||bound.generation!==row.binding_generation)fail('CONFLICT');
  const source=this.db.prepare('SELECT digest,size,author_id FROM document_versions WHERE document_id=? AND revision=?').get(row.document_id,row.revision) as any;
  if(source?.digest!==row.digest||source.size!==row.size||source.author_id!==row.author_id)fail('PROVIDER_SOURCE_CHANGED');
 }
 private owned(attempt:DeliveryAttempt,now:number):AttemptRow{
  validTime(now);const row=this.db.prepare('SELECT * FROM provider_delivery_attempts WHERE id=?').get(attempt.id) as AttemptRow|undefined;
  if(!row||row.lease_job_id!==attempt.job.id||row.lease_token!==attempt.job.token||row.lease_until<=now||!this.queue.owns(attempt.job,now))fail('LEASE_LOST');
  return row;
 }
 /** Pin the latest request; reclaiming any writing owner can only lead to read-back. */
 acquire(job:ClaimedJob,now=Date.now()):DeliveryAttempt|null{
  validTime(now);return transaction(this.db,()=>{
   if(job.kind!=='provider.deliver'||!this.queue.owns(job,now))fail('LEASE_LOST');
   const documentId=job.payload.documentId,revision=job.payload.requestedRevision;
   if(typeof documentId!=='string'||!Number.isSafeInteger(revision)||Number(revision)<1||Object.keys(job.payload).length!==2)fail('INVALID_REQUEST');
   let row=this.db.prepare("SELECT * FROM provider_delivery_attempts WHERE document_id=? AND state NOT IN ('confirmed','retired')").get(documentId) as AttemptRow|undefined;
   if(row){
    if(row.lease_until>now&&(row.lease_job_id!==job.id||row.lease_token!==job.token))fail('PROVIDER_BUSY');
    if(['conflict','retryable','blocked'].includes(row.state))fail('CONFLICT');
    // Recover uncertainty even if the author/config was revoked after dispatch.
    // This grants no IO permission: check/confirm still require current scope.
    if(row.state==='prepared')this.scope(row);
    // Never turn a reclaimed writing lease back into a write permission.
    const state=row.state==='writing'?'unknown':row.state;
    this.db.prepare('UPDATE provider_delivery_attempts SET state=?,lease_job_id=?,lease_token=?,lease_until=?,updated_at=? WHERE id=?').run(state,job.id,job.token,now+leaseMs,now,row.id);
    row=this.db.prepare('SELECT * FROM provider_delivery_attempts WHERE id=?').get(row.id) as AttemptRow;
   }else{
    const source=this.db.prepare(`SELECT r.requested_revision,v.author_id,v.digest,v.size,b.fingerprint,b.confirmed_revision,b.generation,c.revision AS connection_revision FROM provider_delivery_requests r JOIN provider_source_bindings b ON b.document_id=r.document_id JOIN provider_connections c ON c.id=b.connection_id JOIN document_versions v ON v.document_id=r.document_id AND v.revision=r.requested_revision WHERE r.document_id=?`).get(documentId) as any;
    if(!source||source.requested_revision<=source.confirmed_revision){if(!this.queue.complete(job,now))fail('LEASE_LOST');return null;}
    const id=randomUUID();
    row={id,document_id:documentId,revision:source.requested_revision,author_id:source.author_id,digest:source.digest,size:source.size,baseline:source.fingerprint,base_revision:source.confirmed_revision,binding_generation:source.generation,connection_revision:source.connection_revision,state:'prepared',lease_job_id:job.id,lease_token:job.token,lease_until:now+leaseMs};
    this.scope(row);
    this.db.prepare(`INSERT INTO provider_delivery_attempts(id,document_id,revision,author_id,digest,size,baseline,base_revision,binding_generation,connection_revision,state,lease_job_id,lease_token,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,documentId,row.revision,row.author_id,row.digest,row.size,row.baseline,row.base_revision,row.binding_generation,row.connection_revision,'prepared',job.id,job.token,now+leaseMs,now,now);
   }
   return decode(row,job);
  });
 }
 check(attempt:DeliveryAttempt,now=Date.now()):void{const row=this.owned(attempt,now);if(!['prepared','writing','unknown'].includes(row.state))fail('CONFLICT');this.scope(row);}
 renew(attempt:DeliveryAttempt,now=Date.now()):void{transaction(this.db,()=>{this.check(attempt,now);if(!this.queue.renew(attempt.job,now,leaseMs))fail('LEASE_LOST');this.db.prepare('UPDATE provider_delivery_attempts SET lease_until=?,updated_at=? WHERE id=?').run(now+leaseMs,now,attempt.id);});}
 markWriting(attempt:DeliveryAttempt,now=Date.now()):void{transaction(this.db,()=>{const row=this.owned(attempt,now);this.scope(row);if(row.state!=='prepared')fail('CONFLICT');this.db.prepare("UPDATE provider_delivery_attempts SET state='writing',updated_at=? WHERE id=?").run(now,row.id);});}
 recordOutcome(attempt:DeliveryAttempt,state:'unknown'|'retryable'|'conflict'|'blocked',code:string,now=Date.now()):void{
  if(!['unknown','retryable','conflict','blocked'].includes(state)||!['PROVIDER_UNKNOWN','PROVIDER_CONFLICT','PROVIDER_UNAVAILABLE','ACCESS_DENIED','PROVIDER_CONFIG_CHANGED','PROVIDER_SOURCE_CHANGED'].includes(code))fail('INVALID_REQUEST');
  transaction(this.db,()=>{const row=this.owned(attempt,now);if(!['prepared','writing','unknown'].includes(row.state))fail('CONFLICT');if(row.state==='prepared'&&['unknown','retryable'].includes(state))fail('CONFLICT');this.db.prepare('UPDATE provider_delivery_attempts SET state=?,error_code=?,updated_at=? WHERE id=?').run(state,code,now,row.id);});
 }
 confirm(attempt:DeliveryAttempt,receipt:{fingerprint:string;digest:string;size:number},now=Date.now()):void{
  if(typeof receipt.fingerprint!=='string'||!receipt.fingerprint||receipt.fingerprint.length>1024||/[\x00-\x1f\x7f]/.test(receipt.fingerprint))fail('INVALID_REQUEST');
  transaction(this.db,()=>{const row=this.owned(attempt,now);this.scope(row);if(!['writing','unknown'].includes(row.state)||receipt.digest!==row.digest||receipt.size!==row.size)fail('CONFLICT');
   this.db.prepare("UPDATE provider_delivery_attempts SET state='confirmed',error_code=NULL,receipt_fingerprint=?,updated_at=? WHERE id=?").run(receipt.fingerprint,now,row.id);
   this.db.prepare('UPDATE provider_source_bindings SET fingerprint=?,confirmed_revision=? WHERE document_id=?').run(receipt.fingerprint,row.revision,row.document_id);
   this.db.prepare('UPDATE documents SET provider_revision=? WHERE id=?').run(row.revision,row.document_id);
   if(!this.queue.complete(attempt.job,now))fail('LEASE_LOST');
   this.db.prepare("INSERT INTO events(kind,document_id,payload,created_at) VALUES('provider.source-confirmed',?,'{}',?)").run(row.document_id,now);
  });
 }
}
