import {randomUUID,createHash} from 'node:crypto';
import {transaction,type Database} from '../database.ts';
import {JobQueue} from '../jobs.ts';
import {DocumentError} from '../document-errors.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {CredentialVault} from './credential-vault.ts';
import {ingressContext} from './ingress-guards.ts';
import {ProviderIngress} from './ingress-inbox.ts';
import {ProviderError,safeProviderError,type ProviderAdapter} from './adapter.ts';
import type {AdapterResolver} from './delivery-worker.ts';
export type IngressResult='idle'|'unchanged'|'applied'|'conflict'|'blocked'|'deferred'|'interrupted';
/** Dedicated worker; shares the provider-source lease with outward delivery. No page request performs this IO. */
export class IngressWorker {
 private db:Database;private vault:CredentialVault;private resolve:AdapterResolver;private clock:()=>number;private queue:JobQueue;private inbox:ProviderIngress;private busy=false;
 constructor(db:Database,store:BlobStore,vault:CredentialVault,resolve:AdapterResolver,options:{clock?:()=>number}={}){
  if(!vault.belongsToDatabase(db))throw new Error('Provider vault requires the worker database');this.db=db;this.vault=vault;this.resolve=resolve;this.clock=options.clock??Date.now;this.queue=new JobQueue(db);this.inbox=new ProviderIngress(db,store,{clock:this.clock});
 }
 async runOnce(signal?:AbortSignal):Promise<IngressResult>{
  if(this.busy)throw new Error('Provider worker is already running');if(signal?.aborted)return 'interrupted';
  const slot=randomUUID(),job=transaction(this.db,()=>{const now=this.clock();if(this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND lease_until>?").get(now))return null;const claim=this.queue.claim(now,30000,'provider.pull');if(claim)this.db.prepare("INSERT INTO worker_slots VALUES('provider-source',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until").run(slot,now+30000);return claim;});
  if(!job)return 'idle';this.busy=true;const controller=new AbortController(),abort=()=>controller.abort(new ProviderError('PROVIDER_CANCELLED'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();let adapter:ProviderAdapter|undefined,heartbeat:ReturnType<typeof setInterval>|undefined,activeSnapshot:string|undefined;
  const owns=()=>{controller.signal.throwIfAborted();const now=this.clock();if(!this.queue.owns(job,now)||!this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND token=? AND lease_until>?").get(slot,now))throw new ProviderError('LEASE_LOST');};
  const complete=()=>{owns();if(!this.queue.complete(job,this.clock()))throw new ProviderError('LEASE_LOST');};
  try{
   owns();const documentId=job.payload.documentId;if(typeof documentId!=='string'||!documentId||documentId.length>128||Object.keys(job.payload).length!==1)throw new ProviderError('PROVIDER_SOURCE_CHANGED');
   const previous=this.inbox.latest(documentId);
   if(previous?.state==='conflict'){complete();return 'conflict';}
   if(previous?.state==='applied'){
    await this.inbox.cleanupApplied(previous.id,job,slot);
    if(previous.lease_job_id===job.id){complete();return 'applied';}
   }else if(previous&&['pending','receiving','failed','discarding'].includes(previous.state)){
    this.inbox.resume(previous.id,job,slot);await this.inbox.discard(previous.id,job);
   }
   const scope=ingressContext(this.db,documentId),check=()=>{owns();const current=ingressContext(this.db,documentId);if(current.connection_id!==scope.connection_id||current.connection_revision!==scope.connection_revision||current.binding_generation!==scope.binding_generation)throw new ProviderError('PROVIDER_CONFIG_CHANGED');};let renewAt=this.clock()+10000;
   heartbeat=setInterval(()=>{try{check();const now=this.clock();if(now>=renewAt){transaction(this.db,()=>{check();if(activeSnapshot){this.inbox.renew(activeSnapshot,job,now);return;}if(!this.queue.renew(job,now,30000)||!this.db.prepare("UPDATE worker_slots SET lease_until=? WHERE name='provider-source' AND token=? AND lease_until>?").run(now+30000,slot,now).changes)throw new ProviderError('LEASE_LOST');});renewAt=now+10000;}}catch(error){controller.abort(error);}},250);
   const connection=this.vault.forBinding({documentId,connectionId:scope.connection_id,connectionRevision:scope.connection_revision,bindingGeneration:scope.binding_generation});adapter=await this.resolve(connection);check();const options={check,signal:controller.signal};

   if(previous?.state==='staged'){
    this.inbox.resume(previous.id,job,slot);activeSnapshot=previous.id;
    const remote=await adapter.read(connection.reference,options);check();
    if(remote.fingerprint!==previous.observed_fingerprint||remote.size!==previous.size){this.inbox.park(previous.id,job,'PROVIDER_CONFLICT');complete();return 'conflict';}
    const hash=createHash('sha256');let size=0;
    for await(const chunk of remote.bytes){check();if(!(chunk instanceof Uint8Array)||size+chunk.byteLength>previous.size!){this.inbox.park(previous.id,job,'PROVIDER_SOURCE_CHANGED');complete();return 'conflict';}for(let offset=0;offset<chunk.byteLength;offset+=65536){check();hash.update(chunk.subarray(offset,offset+65536));}size+=chunk.byteLength;}
    check();if(size!==previous.size||hash.digest('hex')!==previous.digest){this.inbox.park(previous.id,job,'PROVIDER_SOURCE_CHANGED');complete();return 'conflict';}
    await this.inbox.commit(previous.id,job,{signal:controller.signal});await this.inbox.cleanupApplied(previous.id,job);complete();return 'applied';
   }
   if(adapter.changed&&!await adapter.changed(connection.reference,scope.fingerprint,options)){check();complete();return 'unchanged';}
   const remote=await adapter.read(connection.reference,options);check();const snapshot=this.inbox.begin({job,slotToken:slot,documentId,connectionRevision:scope.connection_revision,baseLocalRevision:scope.local_revision,baseProviderRevision:scope.provider_revision!,baseFingerprint:scope.fingerprint,observedFingerprint:remote.fingerprint,declaredSize:remote.size,observedAt:this.clock()});
   activeSnapshot=snapshot.id;const staged=await this.inbox.receive(snapshot.id,job,remote.bytes,{signal:controller.signal});check();if(staged.state==='conflict'){complete();return 'conflict';}
   await this.inbox.commit(snapshot.id,job,{signal:controller.signal});await this.inbox.cleanupApplied(snapshot.id,job);complete();return 'applied';
  }catch(error){
   const now=this.clock();if(!this.queue.owns(job,now)||controller.signal.aborted||!this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND token=? AND lease_until>?").get(slot,now))return 'interrupted';
   if(error instanceof DocumentError&&['CONFLICT','OFFICE_ACTIVE','SAVE_PENDING'].includes(error.code)){complete();return 'conflict';}
   if(error instanceof DocumentError&&error.code==='INGRESS_QUOTA'){this.queue.reject(job,'INGRESS_QUOTA',now);return 'blocked';}
   const safe=error instanceof DocumentError&&error.code==='INGRESS_SCOPE_CHANGED'?new ProviderError('PROVIDER_CONFIG_CHANGED'):safeProviderError(error);
   if(safe.code==='PROVIDER_UNAVAILABLE'){this.queue.fail(job,safe.code,now,60000);return 'deferred';}
   this.queue.reject(job,safe.code,now);return 'blocked';
  }finally{if(heartbeat)clearInterval(heartbeat);signal?.removeEventListener('abort',abort);if(adapter)try{await adapter.close();}catch{}this.db.prepare("DELETE FROM worker_slots WHERE name='provider-source' AND token=?").run(slot);this.busy=false;}
 }
}
