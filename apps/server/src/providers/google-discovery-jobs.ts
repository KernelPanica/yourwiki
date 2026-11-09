import {scheduleGoogleReconciliation} from './google-reconciliation.ts';
import {isDeepStrictEqual} from 'node:util';
import {transaction,readTransaction,type Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {JobQueue,type ClaimedJob} from '../jobs.ts';
import {SecretConfigs} from './secret-config.ts';
import {connectionFields,connectionId} from './connection-records.ts';
import {googleFileId} from './google-read-http.ts';
import type {GoogleDiscoveryPage} from './google-discovery.ts';
export const googleDiscoveryJobKind='provider.google-discover';
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
type Row={job_id:string;actor_id:string;connection_id:string;connection_revision:number;folder_id:string|null;previous_job_id:string|null;encrypted_page:string|null;created_at:number;expires_at:number};
const context=(r:Row)=>({jobId:r.job_id,actorId:r.actor_id,connectionId:r.connection_id,connectionRevision:r.connection_revision,folderId:r.folder_id,previousOperationId:r.previous_job_id});
/** DB-only admission/receipts. No provider or access-token requests on HTTP paths. */
export class GoogleDiscoveryRequests{
 private db:Database;private configs:SecretConfigs;private queue:JobQueue;private clock:()=>number;
 constructor(db:Database,configs:SecretConfigs,options:{clock?:()=>number}={}){this.db=db;this.configs=configs;this.queue=new JobQueue(db);this.clock=options.clock??Date.now;}
 belongsToDatabase(db:Database){return db===this.db;}
 private admin(id:string){if(!this.db.prepare("SELECT 1 FROM users WHERE id=? AND active=1 AND admin_role='giga'").get(id))throw new DocumentError('ACCESS_DENIED');}
 private row(id:string){return this.db.prepare('SELECT * FROM provider_google_discovery_jobs WHERE job_id=?').get(id) as Row|undefined;}
 private current(row:Row){this.admin(row.actor_id);if(row.expires_at<=this.clock())throw new DocumentError('NOT_FOUND');if(!this.db.prepare("SELECT 1 FROM provider_connections WHERE id=? AND revision=? AND provider='google' AND enabled=1").get(row.connection_id,row.connection_revision))throw new DocumentError('PROVIDER_CONFIG_CHANGED');}
 private page(row:Row):GoogleDiscoveryPage{
  try{if(!row.encrypted_page)throw new Error();const value=this.configs.decrypt(row.encrypted_page);if(!isDeepStrictEqual(value.context,context(row))||!value.page||typeof value.page!=='object')throw new Error();return value.page as GoogleDiscoveryPage;}catch{throw new DocumentError('CONFIG_UNAVAILABLE');}
 }
 request(user:string,input:unknown){return transaction(this.db,()=>{
  this.admin(user);const v=connectionFields(input,['requestId','connectionId','baseRevision','folderId','previousOperationId'],['requestId','connectionId','baseRevision','folderId','previousOperationId']);if(!uuid(v.requestId)||!connectionId(v.connectionId)||!Number.isSafeInteger(v.baseRevision)||Number(v.baseRevision)<1||v.previousOperationId!==null&&!uuid(v.previousOperationId))throw new DocumentError('INVALID_REQUEST');if(v.folderId!==null)try{googleFileId(v.folderId);}catch{throw new DocumentError('INVALID_REQUEST');}
  const now=this.clock(),payload={actorId:user,...v},key=user+':'+v.requestId,prior=this.db.prepare('SELECT id,payload FROM jobs WHERE kind=? AND dedupe_key=?').get(googleDiscoveryJobKind,key) as {id:string;payload:string}|undefined;
  if(prior){if(!isDeepStrictEqual(JSON.parse(prior.payload),payload))throw new DocumentError('OPERATION_MISMATCH');return this.status(user,prior.id);}
  if(!this.db.prepare("SELECT 1 FROM provider_connections WHERE id=? AND revision=? AND provider='google' AND enabled=1").get(v.connectionId,v.baseRevision))throw new DocumentError('PROVIDER_CONFIG_CHANGED');
  this.db.prepare('DELETE FROM provider_google_discovery_jobs WHERE job_id IN (SELECT job_id FROM provider_google_discovery_jobs WHERE expires_at<=? ORDER BY expires_at LIMIT 256)').run(now);
  const n=this.db.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(d.actor_id=? AND j.state!='failed'),0) AS own FROM provider_google_discovery_jobs d JOIN jobs j ON j.id=d.job_id").get(user) as {total:number;own:number};if(n.total>=256||n.own>=16)throw new DocumentError('DISCOVERY_LIMIT');
  if(v.previousOperationId!==null){const previous=this.row(v.previousOperationId as string);if(!previous||previous.actor_id!==user||previous.connection_id!==v.connectionId||previous.connection_revision!==v.baseRevision||previous.folder_id!==v.folderId)throw new DocumentError('NOT_FOUND');this.current(previous);if(!this.page(previous).nextPageToken)throw new DocumentError('CONFLICT');}
  const id=this.queue.enqueue({kind:googleDiscoveryJobKind,key,payload,maxAttempts:3},now);this.db.prepare('INSERT INTO provider_google_discovery_jobs(job_id,actor_id,connection_id,connection_revision,folder_id,previous_job_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(id,user,v.connectionId,v.baseRevision,v.folderId,v.previousOperationId,now,now+1800000);if(v.folderId===null&&v.previousOperationId===null)scheduleGoogleReconciliation(this.db,id,user,String(v.connectionId),Number(v.baseRevision),now);return this.status(user,id);
 });}
 status(user:string,id:string){return readTransaction(this.db,()=>{
  this.admin(user);if(!uuid(id))throw new DocumentError('INVALID_REQUEST');const row=this.row(id);if(!row||row.actor_id!==user||row.expires_at<=this.clock())throw new DocumentError('NOT_FOUND');const job=this.queue.status(id);if(!job)throw new DocumentError('NOT_FOUND');
  const current=!!this.db.prepare("SELECT 1 FROM provider_connections WHERE id=? AND revision=? AND enabled=1 AND provider='google'").get(row.connection_id,row.connection_revision);const page=current&&job.state==='succeeded'?this.page(row):null;
  const safe=['PROVIDER_CONFIG_CHANGED','PROVIDER_SOURCE_CHANGED','PROVIDER_INVALID_REFERENCE','PROVIDER_CONFLICT','PROVIDER_UNAVAILABLE','ACCESS_DENIED','RETRY_EXHAUSTED'];
  return {operationId:id,state:current?job.state:'failed',hasMore:!!page?.nextPageToken,page:page?{folderId:page.folderId,items:page.items}:null,errorCode:!current?'PROVIDER_CONFIG_CHANGED':job.error_code?(safe.includes(job.error_code)?job.error_code:'PROVIDER_UNAVAILABLE'):null};
 });}
 reconciliation(user:string,id:string){return readTransaction(this.db,()=>{this.admin(user);if(!uuid(id))throw new DocumentError('INVALID_REQUEST');const row=this.row(id);if(!row||row.actor_id!==user)throw new DocumentError('NOT_FOUND');this.current(row);const scan=this.db.prepare('SELECT * FROM provider_google_reconciliations WHERE discovery_id=COALESCE((SELECT canonical_id FROM provider_google_reconciliations WHERE discovery_id=?),?)').get(id,id) as {job_id:string;checked:number;missing:number;restored:number;skipped:number;created_at:number;finished_at:number|null}|undefined;if(!scan)return {state:'not_requested',checked:0,missing:0,restored:0,skipped:0,errorCode:null};const job=this.queue.status(scan.job_id);return {state:job?.state??'failed',checked:scan.checked,missing:scan.missing,restored:scan.restored,skipped:scan.skipped,errorCode:job?.error_code??null};});}
 /** Trusted import selection only. The worker still verifies current source bytes/identity. */
 selected(user:string,id:string,reference:string){return readTransaction(this.db,()=>{this.admin(user);if(!uuid(id))throw new DocumentError('INVALID_REQUEST');googleFileId(reference);const row=this.row(id);if(!row||row.actor_id!==user)throw new DocumentError('NOT_FOUND');this.current(row);if(this.queue.status(id)?.state!=='succeeded')throw new DocumentError('CONFLICT');const file=this.page(row).items.find(file=>file.id===reference);if(!file||file.kind==='folder')throw new DocumentError('NOT_FOUND');return {connectionId:row.connection_id,connectionRevision:row.connection_revision,file};});}
 /** Worker-only immutable scope; caller must additionally own the live job and source slot. */
 scope(job:ClaimedJob){const row=this.row(job.id);if(!row||job.kind!==googleDiscoveryJobKind)throw new DocumentError('NOT_FOUND');this.current(row);const stored=this.queue.status(job.id);if(!stored||!isDeepStrictEqual(stored.payload,job.payload))throw new DocumentError('OPERATION_MISMATCH');let pageToken:string|undefined;if(row.previous_job_id){const previous=this.row(row.previous_job_id);if(!previous||previous.actor_id!==row.actor_id||previous.connection_id!==row.connection_id||previous.connection_revision!==row.connection_revision||previous.folder_id!==row.folder_id)throw new DocumentError('NOT_FOUND');this.current(previous);pageToken=this.page(previous).nextPageToken??undefined;if(!pageToken)throw new DocumentError('CONFLICT');}return {row,folderId:row.folder_id??undefined,pageToken};}
 publish(job:ClaimedJob,page:GoogleDiscoveryPage){transaction(this.db,()=>{const {row}=this.scope(job);if(!this.queue.owns(job,this.clock()))throw new DocumentError('LEASE_LOST');const cipher=this.configs.encrypt({context:context(row),page});if(this.db.prepare('UPDATE provider_google_discovery_jobs SET encrypted_page=? WHERE job_id=? AND encrypted_page IS NULL').run(cipher,job.id).changes!==1)throw new DocumentError('CONFLICT');if(!this.queue.complete(job,this.clock()))throw new DocumentError('LEASE_LOST');});}
}
