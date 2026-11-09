import {trashBaselineMatches} from './google-trash-worker.ts';
import {randomUUID} from 'node:crypto';
import {transaction,type Database} from '../database.ts';
import {JobQueue} from '../jobs.ts';
import {GoogleLifecycle,googleLifecycleKind,type GoogleOperation} from './google-lifecycle.ts';
import {SecretConfigs} from './secret-config.ts';
import {GoogleAuthPool} from './google-auth-pool.ts';
import {GoogleReadHttp,googleFileId} from './google-read-http.ts';
import {GoogleControlHttp} from './google-control-http.ts';
import {GoogleMetadata} from './google-metadata.ts';
import {googleManagedRecipients} from './google-grants.ts';
import {googleSourceFingerprint} from './google-reader.ts';
import {ProviderError} from './adapter.ts';
/** No blind create/move replay. Reclaimed dispatches only read the exact private operation marker. */
export class GoogleLifecycleWorker{
 private db:Database;private repo:GoogleLifecycle;private queue:JobQueue;private auth:GoogleAuthPool;private ownAuth:boolean;private request:typeof fetch;private lifetime=new AbortController();private running:Promise<string>|undefined;
 constructor(db:Database,configs:SecretConfigs,options:{fetch?:typeof fetch;authPool?:GoogleAuthPool}={}){this.db=db;this.repo=new GoogleLifecycle(db,configs);this.queue=new JobQueue(db);if(options.authPool&&!options.authPool.belongsToDatabase(db))throw new Error('Foreign auth pool');this.auth=options.authPool??new GoogleAuthPool(db,configs,options);this.ownAuth=!options.authPool;this.request=options.fetch??fetch;}
 runOnce(parent?:AbortSignal):Promise<string>{if(this.running)throw new Error('Google lifecycle worker already running');if(parent?.aborted||this.lifetime.signal.aborted)return Promise.resolve('idle');const work=this.run(parent).finally(()=>{if(this.running===work)this.running=undefined;});this.running=work;return work;}
 private async run(parent?:AbortSignal){const slot=randomUUID(),job=transaction(this.db,()=>{const now=Date.now();if(this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND lease_until>?").get(now))return null;const claimed=this.queue.claim(now,30000,googleLifecycleKind);if(claimed)this.db.prepare("INSERT INTO worker_slots VALUES('provider-source',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until").run(slot,now+30000);return claimed;});if(!job)return 'idle';const signal=AbortSignal.any([this.lifetime.signal,...(parent?[parent]:[])]);let drive:GoogleReadHttp|undefined,control:GoogleControlHttp|undefined,definitelyRejected=false;
  const owns=()=>{if(signal.aborted||!this.queue.owns(job)||!this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND token=? AND lease_until>?").get(slot,Date.now()))throw new ProviderError('LEASE_LOST');};
  const timer=setInterval(()=>{try{transaction(this.db,()=>{owns();if(!this.queue.renew(job))throw new ProviderError('LEASE_LOST');this.db.prepare("UPDATE worker_slots SET lease_until=? WHERE name='provider-source' AND token=?").run(Date.now()+30000,slot);});}catch{/* Boundary checks stop IO after lease loss. */}},10000);
  try{owns();let {row,connection}=this.repo.scope(job,false);if(['confirmed','importing'].includes(row.state)){this.queue.complete(job);return 'confirmed';}
   const check=()=>{owns();this.repo.scope(job,false);},auth={access:(scope:Parameters<GoogleAuthPool['access']>[2])=>this.auth.access(connection.id,connection.revision,scope),invalidate:(token:string)=>this.auth.invalidate(connection.id,connection.revision,token)};drive=new GoogleReadHttp(auth,{fetch:this.request});control=new GoogleControlHttp(auth,{fetch:this.request});const scope={signal,check},metadata=new GoogleMetadata(drive,async id=>googleManagedRecipients(this.db,connection.id,connection.revision,id));
   const verifyDestination=async()=>{const folder=await metadata.folder(row.destination_reference!,connection.root,scope),raw=await drive!.file(folder.id,'id,shared,ownedByMe,trashed',scope);if(raw.shared!==false||raw.ownedByMe!==true||raw.trashed!==false)throw new ProviderError('ACCESS_DENIED');return folder;};
   const canonicalDestination=await verifyDestination();
   const marker=async(reference:string)=>{const raw=await drive!.file(reference,'id,appProperties,name,mimeType,parents,trashed',scope),properties=raw.appProperties as Record<string,unknown>|undefined;if(raw.id!==reference||properties?.yourwikiLifecycleOperation!==job.id)return null;if(raw.name!==row.title||raw.trashed!==false||!Array.isArray(raw.parents)||raw.parents.length!==1||raw.parents[0]!==canonicalDestination.id)throw new ProviderError('PROVIDER_CONFLICT');return reference;};
   if(['dispatched','unknown'].includes(row.state)){
    let reference:string|null=null;
    if(row.reference)reference=await marker(row.reference);
    else{const page=await control.call('GET','files',{q:"appProperties has { key='yourwikiLifecycleOperation' and value='"+job.id+"' } and 'me' in owners",spaces:'drive',corpora:'user',pageSize:'100',fields:'files(id),nextPageToken,incompleteSearch'},undefined,scope);if(page.incompleteSearch||page.nextPageToken||!Array.isArray(page.files)||page.files.length>1)throw new ProviderError('PROVIDER_CONFLICT');if(page.files.length){const id=googleFileId((page.files[0] as Record<string,unknown>)?.id);reference=await marker(id);}}
    if(!reference){this.db.prepare("UPDATE provider_google_operations SET state='unknown',error_code='PROVIDER_UNKNOWN',updated_at=? WHERE job_id=?").run(Date.now(),job.id);this.queue.fail(job,'PROVIDER_UNKNOWN',Date.now(),60000);return 'deferred';}this.repo.remote(job,reference);row=this.repo.row(job.id)!;
   }
   if(row.state==='queued'){
    this.repo.scope(job);const destination=await verifyDestination();
    const send=async(method:'POST'|'PATCH',path:string,query:Record<string,string>,body:unknown)=>{try{return await control!.call(method,path,query,body,{signal,check:guard,beforeDispatch:()=>this.repo.dispatched(job)});}catch(error){definitelyRejected=error instanceof ProviderError&&error.outcome==='not_written';throw error;}};
    const guard=()=>{owns();this.repo.scope(job);};
    if(row.action==='move'){
     const source=await metadata.verify(row.reference!,connection.root,scope);if(!trashBaselineMatches(row.baseline!,source))throw new ProviderError('PROVIDER_CONFLICT');
     await send('PATCH','files/'+row.reference,{addParents:destination.id,removeParents:source.parents[0],fields:'id'}, {name:row.title,appProperties:{yourwikiLifecycleOperation:job.id}});
    }else{
     await send('POST','files',{fields:'id'}, {name:row.title,mimeType:'application/vnd.google-apps.'+row.kind,parents:[destination.id],appProperties:{yourwikiLifecycleOperation:job.id},writersCanShare:false}).then(receipt=>{const reference=googleFileId(receipt.id);check();this.db.prepare('UPDATE provider_google_operations SET reference=? WHERE job_id=?').run(reference,job.id);});
    }
    row=this.repo.row(job.id)!;const confirmed=row.reference?await marker(row.reference):null;if(!confirmed)throw new ProviderError('PROVIDER_UNKNOWN','unknown');this.repo.remote(job,confirmed);row=this.repo.row(job.id)!;
   }
   if(row.state!=='remote_ready'||!row.reference)throw new ProviderError('PROVIDER_SOURCE_CHANGED');
   if(!await marker(row.reference))throw new ProviderError('PROVIDER_CONFLICT');
   if(row.action==='create'&&row.kind==='folder'){const folder=await metadata.folder(row.reference,connection.root,scope);if(folder.kind!=='folder')throw new ProviderError('PROVIDER_SOURCE_CHANGED');this.repo.finishFolder(job);return 'created';}
   const source=await metadata.verify(row.reference,connection.root,scope);if(row.action==='create'&&source.kind!==row.kind)throw new ProviderError('PROVIDER_SOURCE_CHANGED');
   if(row.action==='move'){this.repo.finishMove(job,googleSourceFingerprint(source));return 'moved';}
   if(!this.repo.advanceImport(job)){this.queue.fail(job,'PROVIDER_UNAVAILABLE',Date.now(),1000);return 'preparing';}return 'created';
  }catch(error){if(signal.aborted||!this.queue.owns(job))return 'interrupted';const row=this.repo.row(job.id),raw=error&&typeof error==='object'&&'code' in error?String(error.code):'PROVIDER_UNAVAILABLE',code=['ACCESS_DENIED','CONFLICT','NOT_FOUND','DOCUMENT_BUSY','PROVIDER_CONFIG_CHANGED','PROVIDER_SOURCE_CHANGED','PROVIDER_CONFLICT','PROVIDER_UNAVAILABLE','PROVIDER_UNKNOWN','CONFIG_UNAVAILABLE'].includes(raw)?raw:'PROVIDER_UNAVAILABLE';
   if(row?.state==='queued'&&code!=='PROVIDER_UNAVAILABLE'||row?.state==='dispatched'&&definitelyRejected){
    this.db.prepare("UPDATE provider_google_operations SET state='failed',error_code=?,updated_at=? WHERE job_id=?").run(code,Date.now(),job.id);this.queue.reject(job,code);return 'blocked';
   }
   if(row?.state==='dispatched')this.db.prepare("UPDATE provider_google_operations SET state='unknown' WHERE job_id=?").run(job.id);this.db.prepare('UPDATE provider_google_operations SET error_code=?,updated_at=? WHERE job_id=?').run(code,Date.now(),job.id);this.queue.fail(job,code,Date.now(),60000);return 'deferred';
  }finally{clearInterval(timer);await Promise.all([drive?.close(),control?.close()]);this.db.prepare("DELETE FROM worker_slots WHERE name='provider-source' AND token=?").run(slot);}
 }
 async close(){this.lifetime.abort();await Promise.allSettled([this.running]);if(this.ownAuth)await this.auth.close();}
}
