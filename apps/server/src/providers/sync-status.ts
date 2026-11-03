import {readTransaction,type Database} from '../database.ts';
import {DocumentService,DocumentError} from '../documents.ts';
import type {BlobStore} from '../storage/blobs.ts';
export type ProviderSyncStatus={documentId:string;kind:'incoming';state:'local_only'|'idle'|'scheduled'|'checking'|'staged'|'conflict'|'applied'|'failed'|'interrupted'|'cleanup'|'blocked';localRevision:number;providerRevision:number|null;snapshotId:string|null;errorCode:string|null};
type Snapshot={id:string;state:string;error_code:string|null;connection_revision:number;lease_job_id:string;lease_until:number;slot_token:string};
type Job={state:string;lease_until:number|null;error_code:string|null};
const codes=['CONFLICT','OFFICE_ACTIVE','SAVE_PENDING','INGRESS_INTERRUPTED','INGRESS_QUOTA','PROVIDER_CONFIG_CHANGED','PROVIDER_SOURCE_CHANGED','PROVIDER_CONFLICT','PROVIDER_UNAVAILABLE','PROVIDER_EXPORT_LIMIT'];
function safeCode(value:string|null,fallback:string|null=null){return value&&codes.includes(value)?value:fallback;}
/** Current local authorization and cached metadata only. Never owns credentials or reads source bytes. */
export class ProviderSync {
 private db:Database;private docs:DocumentService;private clock:()=>number;
 constructor(db:Database,store:BlobStore,options:{clock?:()=>number}={}){this.db=db;this.docs=new DocumentService(db,store);this.clock=options.clock??Date.now;}
 private job(id:string):Job|undefined{return this.db.prepare('SELECT state,lease_until,error_code FROM jobs WHERE id=?').get(id) as Job|undefined;}
 status(user:string,id:string):ProviderSyncStatus{return readTransaction(this.db,()=>{
  if(!this.docs.processingStatus(user,id))throw new DocumentError('NOT_FOUND');
  const doc=this.db.prepare('SELECT local_revision,provider_revision FROM documents WHERE id=?').get(id) as {local_revision:number;provider_revision:number|null};
  const base={documentId:id,kind:'incoming' as const,localRevision:doc.local_revision,providerRevision:doc.provider_revision,snapshotId:null as string|null,errorCode:null as string|null};
  const binding=this.db.prepare('SELECT c.enabled,c.revision FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=?').get(id) as {enabled:number;revision:number}|undefined;
  if(!binding)return {...base,state:'local_only'};
  const snapshot=this.db.prepare('SELECT id,state,error_code,connection_revision,lease_job_id,lease_until,slot_token FROM provider_ingress_snapshots WHERE document_id=? ORDER BY generation DESC LIMIT 1').get(id) as Snapshot|undefined;
  if(snapshot&&snapshot.state!=='discarded')base.snapshotId=snapshot.id;
  if(snapshot?.state==='conflict')return {...base,state:'conflict',errorCode:safeCode(snapshot.error_code,'CONFLICT')};
  if(!binding.enabled||snapshot&&['staged','pending','receiving'].includes(snapshot.state)&&snapshot.connection_revision!==binding.revision)return {...base,state:'blocked',errorCode:'PROVIDER_CONFIG_CHANGED'};
  const now=this.clock();
  if(snapshot?.state==='staged')return {...base,state:'staged'};
  if(snapshot&&['pending','receiving'].includes(snapshot.state)){
   const job=this.job(snapshot.lease_job_id),slot=this.db.prepare("SELECT lease_until FROM worker_slots WHERE name='provider-source' AND token=?").get(snapshot.slot_token) as {lease_until:number}|undefined;
   const live=snapshot.lease_until>now&&job?.state==='running'&&Number(job.lease_until)>now&&Number(slot?.lease_until)>now;
   return {...base,state:live?'checking':'interrupted',errorCode:live?null:'INGRESS_INTERRUPTED'};
  }
  if(snapshot?.state==='failed')return {...base,state:'failed',errorCode:safeCode(snapshot.error_code,'INGRESS_INTERRUPTED')};
  if(snapshot?.state==='discarding')return {...base,state:'cleanup'};
  const scheduled=this.db.prepare('SELECT job_id FROM provider_sync_checks WHERE document_id=?').get(id) as {job_id:string}|undefined,job=scheduled?this.job(scheduled.job_id):undefined;
  if(job?.state==='queued')return {...base,state:'scheduled',errorCode:safeCode(job.error_code)};
  if(job?.state==='running')return {...base,state:Number(job.lease_until)>now?'checking':'interrupted',errorCode:Number(job.lease_until)>now?null:'INGRESS_INTERRUPTED'};
  if(job?.state==='failed'){const code=safeCode(job.error_code,'PROVIDER_UNAVAILABLE');return {...base,state:['PROVIDER_CONFIG_CHANGED','INGRESS_QUOTA'].includes(code!)?'blocked':'failed',errorCode:code};}
  // A completed explicit action may have refused its source operation. Preserve that
  // receipt in fresh page metadata even after the browser no longer remembers its UUID.
  const refused=job?.state==='succeeded'&&scheduled?this.db.prepare("SELECT error_code FROM provider_sync_actions WHERE job_id=? AND state='refused'").get(scheduled.job_id) as {error_code:string}|undefined:undefined;
  if(refused){const code=safeCode(refused.error_code,'PROVIDER_UNAVAILABLE');return {...base,state:['PROVIDER_CONFIG_CHANGED','INGRESS_QUOTA'].includes(code!)?'blocked':'failed',errorCode:code};}
  return {...base,state:snapshot?.state==='applied'?'applied':'idle'};
 });}
}
