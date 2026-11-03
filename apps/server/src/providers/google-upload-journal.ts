import {transaction,type Database} from '../database.ts';
import {JobQueue} from '../jobs.ts';
import {ProviderError} from './adapter.ts';
import {DeliveryAttempts,type DeliveryAttempt} from './delivery-attempts.ts';
import {SecretConfigs} from './secret-config.ts';
import {googleUploadCapability} from './google-upload-status.ts';
type Phase='reserved'|'initiating'|'ready'|'dispatched'|'unknown';
type Row={attempt_id:string;connection_id:string;connection_revision:number;reference:string;phase:Phase;encrypted_session:string|null;created_at:number;updated_at:number};
type Context={id:string;document_id:string;revision:number;author_id:string;digest:string;size:number;baseline:string;base_revision:number;binding_generation:number;connection_revision:number;state:string;lease_job_id:string;lease_token:string;lease_until:number;connection_id:string;reference:string;provider:string;enabled:number;current_revision:number};
export type GoogleUploadSnapshot={phase:Phase;sessionUrl:string|null};
function fail(code='PROVIDER_SOURCE_CHANGED'):never{throw new ProviderError(code);}
/** Worker-only durable capability journal. Loading a receipt never authorizes IO or replay. */
export class GoogleUploadJournal{
 private db:Database;private configs:SecretConfigs;private attempts:DeliveryAttempts;private queue:JobQueue;
 constructor(db:Database,configs:SecretConfigs){this.db=db;this.configs=configs;this.attempts=new DeliveryAttempts(db);this.queue=new JobQueue(db);}
 private context(attempt:DeliveryAttempt,now:number,scope=true):Context{
  if(!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-30000)fail();
  const row=this.db.prepare('SELECT a.*,b.connection_id,b.reference,c.provider,c.enabled,c.revision AS current_revision FROM provider_delivery_attempts a JOIN provider_source_bindings b ON b.document_id=a.document_id JOIN provider_connections c ON c.id=b.connection_id WHERE a.id=?').get(attempt.id) as Context|undefined;
  if(!row||row.lease_job_id!==attempt.job.id||row.lease_token!==attempt.job.token||row.lease_until<=now||!this.queue.owns(attempt.job,now))fail('LEASE_LOST');
  if(row.document_id!==attempt.documentId||row.revision!==attempt.revision||row.author_id!==attempt.authorId||row.digest!==attempt.digest||row.size!==attempt.size||row.baseline!==attempt.baseline||row.base_revision!==attempt.baseRevision||row.binding_generation!==attempt.bindingGeneration||row.connection_revision!==attempt.connectionRevision)fail();
  if(!['writing','unknown'].includes(row.state))fail();
  if(scope){this.attempts.check(attempt,now);if(row.provider!=='google'||!row.enabled||row.current_revision!==row.connection_revision)fail('PROVIDER_CONFIG_CHANGED');}
  return row;
 }
 private row(id:string):Row|undefined{return this.db.prepare('SELECT * FROM provider_google_uploads WHERE attempt_id=?').get(id) as Row|undefined;}
 private identity(context:Context,row:Row){
  if(row.attempt_id!==context.id||row.connection_id!==context.connection_id||row.connection_revision!==context.connection_revision||row.reference!==context.reference)fail('PROVIDER_CONFIG_CHANGED');
  return JSON.stringify([context.id,context.document_id,context.revision,context.author_id,context.digest,context.size,context.baseline,context.base_revision,context.binding_generation,row.connection_id,row.connection_revision,row.reference]);
 }
 private snapshot(context:Context,row:Row):GoogleUploadSnapshot{
  const identity=this.identity(context,row);if(row.encrypted_session===null)return {phase:row.phase,sessionUrl:null};
  try{const value=this.configs.decrypt(row.encrypted_session);if(Object.keys(value).length!==2||value.context!==identity||typeof value.url!=='string')throw new Error();const sessionUrl=googleUploadCapability({reference:row.reference,size:context.size,sessionUrl:value.url});return {phase:row.phase,sessionUrl};}catch{fail('PROVIDER_CONFIG_CHANGED');}
 }
 load(attempt:DeliveryAttempt,now=Date.now()):GoogleUploadSnapshot|null{
  return transaction(this.db,()=>{const context=this.context(attempt,now),row=this.row(context.id);return row?this.snapshot(context,row):null;});
 }
 reserve(attempt:DeliveryAttempt,now=Date.now()):GoogleUploadSnapshot{
  return transaction(this.db,()=>{const context=this.context(attempt,now),existing=this.row(context.id);if(existing)return this.snapshot(context,existing);if(context.state!=='writing')fail();
   this.db.prepare("INSERT INTO provider_google_uploads(attempt_id,connection_id,connection_revision,reference,phase,created_at,updated_at) VALUES(?,?,?,?,'reserved',?,?)").run(context.id,context.connection_id,context.connection_revision,context.reference,now,now);return {phase:'reserved',sessionUrl:null};
  });
 }
 markInitiating(attempt:DeliveryAttempt,now=Date.now()):void{
  transaction(this.db,()=>{const context=this.context(attempt,now),row=this.row(context.id);if(context.state!=='writing'||row?.phase!=='reserved')fail();this.identity(context,row);this.db.prepare("UPDATE provider_google_uploads SET phase='initiating',updated_at=? WHERE attempt_id=?").run(now,context.id);});
 }
 attach(attempt:DeliveryAttempt,sessionUrl:string,now=Date.now()):void{
  transaction(this.db,()=>{const context=this.context(attempt,now),row=this.row(context.id);if(context.state!=='writing'||row?.phase!=='initiating')fail();const identity=this.identity(context,row),url=googleUploadCapability({reference:row.reference,size:context.size,sessionUrl});let encrypted:string;try{encrypted=this.configs.encrypt({context:identity,url});}catch{fail('PROVIDER_CONFIG_CHANGED');}this.db.prepare("UPDATE provider_google_uploads SET phase='ready',encrypted_session=?,updated_at=? WHERE attempt_id=?").run(encrypted,now,context.id);});
 }
 markDispatched(attempt:DeliveryAttempt,now=Date.now()):void{
  transaction(this.db,()=>{const context=this.context(attempt,now),row=this.row(context.id);if(context.state!=='writing'||row?.phase!=='ready')fail();this.snapshot(context,row);this.db.prepare("UPDATE provider_google_uploads SET phase='dispatched',updated_at=? WHERE attempt_id=?").run(now,context.id);});
 }
 /** Recording uncertainty is allowed after revocation; it neither decrypts nor grants IO. */
 markUnknown(attempt:DeliveryAttempt,now=Date.now()):void{
  transaction(this.db,()=>{const context=this.context(attempt,now,false),row=this.row(context.id);if(!row||!['initiating','ready','dispatched','unknown'].includes(row.phase))fail();this.identity(context,row);if(row.phase!=='unknown')this.db.prepare("UPDATE provider_google_uploads SET phase='unknown',updated_at=? WHERE attempt_id=?").run(now,context.id);});
 }
}
