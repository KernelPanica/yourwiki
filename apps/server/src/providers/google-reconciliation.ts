import {randomUUID} from 'node:crypto';
import {transaction,type Database} from '../database.ts';
import {JobQueue} from '../jobs.ts';
import {SecretConfigs} from './secret-config.ts';
import {GoogleAuthPool} from './google-auth-pool.ts';
import {GoogleReadHttp} from './google-read-http.ts';
import {GoogleMetadata} from './google-metadata.ts';
import {ProviderError} from './adapter.ts';

const kind='provider.google-reconcile';
type Scan={discovery_id:string;connection_id:string;connection_revision:number;actor_id:string;job_id:string;cursor:string;created_at:number};
type Source={id:string;reference:string;kind:string;name:string;parent_id:string|null;trashed:number;revision:number|null};
const sources=`SELECT r.id,b.reference,r.kind,d.title AS name,r.parent_id,r.trashed,d.local_revision AS revision FROM provider_source_bindings b JOIN documents d ON d.id=b.document_id JOIN resources r ON r.id=d.id WHERE b.connection_id=? AND NOT EXISTS(SELECT 1 FROM resource_tombstones WHERE resource_id=r.id)
 UNION ALL SELECT r.id,f.reference,r.kind,f.title AS name,r.parent_id,r.trashed,NULL AS revision FROM provider_google_folders f JOIN resources r ON r.id=f.resource_id WHERE f.connection_id=? AND NOT EXISTS(SELECT 1 FROM resource_tombstones WHERE resource_id=r.id)`;
export function scheduleGoogleReconciliation(db:Database,discoveryId:string,actor:string,connection:string,revision:number,now:number){
 const active=db.prepare("SELECT s.discovery_id,s.job_id FROM provider_google_reconciliations s JOIN jobs j ON j.id=s.job_id WHERE s.connection_id=? AND s.connection_revision=? AND s.actor_id=? AND s.canonical_id IS NULL AND s.finished_at IS NULL AND j.state IN ('queued','running') ORDER BY s.created_at DESC LIMIT 1").get(connection,revision,actor) as {discovery_id:string;job_id:string}|undefined;
 if(active){db.prepare('INSERT INTO provider_google_reconciliations(discovery_id,connection_id,connection_revision,actor_id,job_id,canonical_id,created_at) VALUES(?,?,?,?,?,?,?)').run(discoveryId,connection,revision,actor,active.job_id,active.discovery_id,now);return;}
 const q=new JobQueue(db),job=q.enqueue({kind,key:discoveryId+':start',payload:{discoveryId},maxAttempts:5},now);
 db.prepare('INSERT INTO provider_google_reconciliations(discovery_id,connection_id,connection_revision,actor_id,job_id,created_at) VALUES(?,?,?,?,?,?)').run(discoveryId,connection,revision,actor,job,now);
 // A requested inventory also brings forward the existing recursive importer.
 db.prepare('UPDATE google_storage_mounts SET next_scan_at=0 WHERE connection_id=?').run(connection);
}
/** Checks each existing binding directly. Empty or partial search pages never prove deletion.
 * All provider operations are GET; absent sources retain their bytes, versions, ACL and binding. */
export class GoogleReconciliationWorker{
 private db:Database;private secrets:SecretConfigs;private queue:JobQueue;private auth:GoogleAuthPool;private ownAuth:boolean;private request:typeof fetch;private lifetime=new AbortController();private running:Promise<string>|undefined;
 constructor(db:Database,secrets:SecretConfigs,options:{fetch?:typeof fetch;authPool?:GoogleAuthPool}={}){this.db=db;this.secrets=secrets;this.queue=new JobQueue(db);if(options.authPool&&!options.authPool.belongsToDatabase(db))throw new Error('Google auth pool requires worker database');this.auth=options.authPool??new GoogleAuthPool(db,secrets,options);this.ownAuth=!options.authPool;this.request=options.fetch??fetch;}
 runOnce(parent?:AbortSignal):Promise<string>{if(this.running)throw new Error('Reconciliation is already running');if(parent?.aborted||this.lifetime.signal.aborted)return Promise.resolve('idle');const work=this.run(parent).finally(()=>{this.running=undefined;});this.running=work;return work;}
 private async run(parent?:AbortSignal){
  const token=randomUUID(),job=transaction(this.db,()=>{const now=Date.now();if(this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND lease_until>?").get(now))return null;const j=this.queue.claim(now,30000,kind);if(j)this.db.prepare("INSERT INTO worker_slots VALUES('provider-source',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until").run(token,now+30000);return j;});if(!job)return 'idle';
  const signal=AbortSignal.any([this.lifetime.signal,...(parent?[parent]:[])]);let http:GoogleReadHttp|undefined;
  const scan=this.db.prepare('SELECT * FROM provider_google_reconciliations WHERE discovery_id=? AND job_id=?').get(job.payload.discoveryId,job.id) as Scan|undefined;
  const check=()=>{if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');if(!this.queue.owns(job)||!this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND token=? AND lease_until>?").get(token,Date.now()))throw new ProviderError('LEASE_LOST');if(!scan||!this.db.prepare("SELECT 1 FROM provider_connections c JOIN users u ON u.id=? WHERE c.id=? AND c.revision=? AND c.enabled=1 AND c.provider='google' AND u.active=1 AND u.admin_role='giga'").get(scan.actor_id,scan.connection_id,scan.connection_revision))throw new ProviderError('PROVIDER_CONFIG_CHANGED');};
  const timer=setInterval(()=>{try{transaction(this.db,()=>{check();this.queue.renew(job,Date.now(),30000);this.db.prepare("UPDATE worker_slots SET lease_until=? WHERE name='provider-source' AND token=?").run(Date.now()+30000,token);});}catch{/* Every read/commit checks the current lease independently. */}},10000);
  try{
   check();const s=scan!,record=this.db.prepare('SELECT encrypted_config FROM provider_connections WHERE id=?').get(s.connection_id) as {encrypted_config:string},config=this.secrets.decrypt(record.encrypted_config),scope={signal,check};
   if(typeof config.root!=='string')throw new ProviderError('PROVIDER_CONFIG_CHANGED');
   http=new GoogleReadHttp({access:o=>this.auth.access(s.connection_id,s.connection_revision,o),invalidate:t=>this.auth.invalidate(s.connection_id,s.connection_revision,t)},{fetch:this.request});
   const root=await new GoogleMetadata(http,async()=>[],{allowExistingShares:true}).root(config.root,scope);
   if(typeof config.google_account_id==='string'){const about=await http.about(scope),user=about.user as {permissionId?:unknown;me?:unknown}|undefined;if(user?.me!==true||user.permissionId!==config.google_account_id)throw new ProviderError('ACCESS_DENIED');}
   const rows=this.db.prepare(`SELECT * FROM (${sources}) WHERE id>? ORDER BY id LIMIT 21`).all(s.connection_id,s.connection_id,s.cursor) as Source[];
   for(const row of rows.slice(0,20)){
    check();const raw=row.reference===root.id?{id:root.id,trashed:false}:await http.fileOrMissing(row.reference,'id,trashed',scope);check();if(raw&&(raw.id!==row.reference||typeof raw.trashed!=='boolean'))throw new ProviderError('PROVIDER_SOURCE_CHANGED');
    transaction(this.db,()=>{
     check();const live=this.db.prepare(`SELECT * FROM (${sources}) WHERE id=?`).get(s.connection_id,s.connection_id,row.id) as Source|undefined;
     const busy=!live||JSON.stringify(live)!==JSON.stringify(row)||this.busy(row.id,row.kind==='folder');
     let missing=0,restored=0;
     if(!busy&&row.reference!==root.id){
      const entry=this.db.prepare("SELECT id,details FROM local_trash WHERE kind='resource' AND object_id=? AND restored_at IS NULL AND purged_at IS NULL ORDER BY deleted_at DESC LIMIT 1").get(row.id) as {id:string;details:string}|undefined,details=entry?JSON.parse(entry.details):{};
      if(!raw||raw.trashed){
       const failed=details.googleDocumentTrash&&!!this.db.prepare("SELECT 1 FROM provider_google_trash WHERE reference=? AND state='failed' AND NOT EXISTS(SELECT 1 FROM provider_google_trash n WHERE n.reference=? AND n.rowid>provider_google_trash.rowid)").get(row.reference,row.reference);
       if(!row.trashed||!entry||details.googleMissingSource||failed){
        const value=JSON.stringify({googleMissingSource:true,connectionId:s.connection_id,reference:row.reference,reason:raw?'trashed':'missing',checkedAt:Date.now(),...(details.googleDocumentTrash?{previousDetails:details}:{})});
        if(entry)this.db.prepare('UPDATE local_trash SET details=? WHERE id=?').run(value,entry.id);
        else this.db.prepare("INSERT INTO local_trash(id,kind,object_id,name,details,deleted_by,deleted_at) VALUES(?,'resource',?,?,?,?,?)").run(randomUUID(),row.id,row.name,value,s.actor_id,Date.now());
        this.db.prepare('UPDATE resources SET trashed=1 WHERE id=?').run(row.id);missing=1;
       }
      }else if(entry&&details.googleMissingSource&&details.connectionId===s.connection_id&&details.reference===row.reference){this.db.prepare('UPDATE resources SET trashed=0 WHERE id=?').run(row.id);this.db.prepare('UPDATE local_trash SET restored_at=? WHERE id=?').run(Date.now(),entry.id);restored=1;}
     }
     this.db.prepare('UPDATE provider_google_reconciliations SET cursor=?,checked=checked+1,missing=missing+?,restored=restored+?,skipped=skipped+? WHERE discovery_id=?').run(row.id,missing,restored,Number(busy),s.discovery_id);
    });
   }
   transaction(this.db,()=>{check();if(rows.length>20){const next=this.queue.enqueue({kind,key:s.discovery_id+':'+rows[19]!.id,payload:{discoveryId:s.discovery_id},maxAttempts:5});this.db.prepare('UPDATE provider_google_reconciliations SET job_id=? WHERE discovery_id=?').run(next,s.discovery_id);}else this.db.prepare('UPDATE provider_google_reconciliations SET finished_at=? WHERE discovery_id=?').run(Date.now(),s.discovery_id);this.queue.complete(job);});return 'reconciled';
  }catch(e){if(!this.queue.owns(job))return 'interrupted';const code=e instanceof ProviderError?e.code:'PROVIDER_UNAVAILABLE';if(['PROVIDER_UNAVAILABLE','PROVIDER_CANCELLED','LEASE_LOST'].includes(code))this.queue.fail(job,'PROVIDER_UNAVAILABLE',Date.now(),10000);else this.queue.reject(job,['ACCESS_DENIED','PROVIDER_CONFIG_CHANGED','PROVIDER_SOURCE_CHANGED'].includes(code)?code:'PROVIDER_UNAVAILABLE');return 'blocked';}
  finally{clearInterval(timer);await http?.close();this.db.prepare("DELETE FROM worker_slots WHERE name='provider-source' AND token=?").run(token);}
 }
 private busy(id:string,folder:boolean){return !!this.db.prepare(`WITH RECURSIVE tree(id,depth) AS (SELECT ?,0 UNION ALL SELECT r.id,t.depth+1 FROM resources r JOIN tree t ON r.parent_id=t.id WHERE ?=1 AND t.depth<33 LIMIT 10001)
 SELECT 1 FROM tree t WHERE t.depth>=33 OR (SELECT count(*) FROM tree)>=10001
 OR EXISTS(SELECT 1 FROM documents d WHERE d.id=t.id AND d.local_revision!=d.provider_revision)
 OR EXISTS(SELECT 1 FROM google_storage_exports e WHERE e.document_id=t.id AND e.state!='confirmed')
 OR EXISTS(SELECT 1 FROM provider_google_operations o WHERE o.document_id=t.id AND o.state NOT IN ('confirmed','failed'))
 OR EXISTS(SELECT 1 FROM provider_google_trash g WHERE g.document_id=t.id AND g.state NOT IN ('confirmed','failed'))
 OR EXISTS(SELECT 1 FROM provider_google_folder_trash g WHERE g.resource_id=t.id AND g.state NOT IN ('confirmed','failed'))
 OR EXISTS(SELECT 1 FROM office_sessions o WHERE o.document_id=t.id AND o.superseded=0 AND o.expires_at>?)
 OR EXISTS(SELECT 1 FROM provider_google_original_sessions o WHERE o.document_id=t.id AND o.closed_at IS NULL AND o.expires_at>?)
 OR EXISTS(SELECT 1 FROM save_operations s WHERE s.document_id=t.id AND s.state='staged')
 OR EXISTS(SELECT 1 FROM provider_delivery_attempts d WHERE d.document_id=t.id AND d.state NOT IN ('confirmed','retired'))
 LIMIT 1`).get(id,Number(folder),Date.now(),Date.now());}
 async close(){this.lifetime.abort();await Promise.allSettled([this.running]);if(this.ownAuth)await this.auth.close();}
}
