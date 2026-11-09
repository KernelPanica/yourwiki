import {acknowledgeGoogleMarkdownEcho} from './google-markdown-conflict-repair.ts';
import {SyncActions} from './sync-actions.ts';
import {randomUUID,createHash} from 'node:crypto';
import {transaction,type Database} from '../database.ts';
import {JobQueue} from '../jobs.ts';
import {DocumentError} from '../document-errors.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {CredentialVault,type AdapterConnection} from './credential-vault.ts';
import {ingressContext,googleIngressPriority} from './ingress-guards.ts';
import {ProviderIngress} from './ingress-inbox.ts';
import {ProviderError,safeProviderError,type ProviderReader,type ProviderRead} from './adapter.ts';
export type IngressResolver=(connection:AdapterConnection)=>Promise<ProviderReader>;
export type IngressResult='idle'|'unchanged'|'discarded'|'applied'|'conflict'|'blocked'|'deferred'|'interrupted';
/** Dedicated worker; shares the provider-source lease with outward delivery. No page request performs this IO. */
export class IngressWorker {
 private db:Database;private vault:CredentialVault;private resolve:IngressResolver;private clock:()=>number;private queue:JobQueue;private inbox:ProviderIngress;private actions:SyncActions;private busy=false;
 constructor(db:Database,store:BlobStore,vault:CredentialVault,resolve:IngressResolver,options:{clock?:()=>number}={}){
  if(!vault.belongsToDatabase(db))throw new Error('Provider vault requires the worker database');this.db=db;this.vault=vault;this.resolve=resolve;this.clock=options.clock??Date.now;this.queue=new JobQueue(db);this.inbox=new ProviderIngress(db,store,{clock:this.clock});this.actions=new SyncActions(db,store,{clock:this.clock});
 }
 private capacity(remote:ProviderRead):{declaredSize:number;sizingMode:'exact'|'bounded'}{
  const size=remote.size===null?remote.maxSize:remote.size;if(!Number.isSafeInteger(size)||size<0||size>4294967296)throw new ProviderError('PROVIDER_SOURCE_CHANGED');return {declaredSize:size,sizingMode:remote.size===null?'bounded':'exact'};
 }
 private async verify(bytes:AsyncIterable<Uint8Array>,expected:{digest:string;size:number},check:()=>void):Promise<boolean>{
  const hash=createHash('sha256');let size=0;
  for await(const chunk of bytes){check();if(!(chunk instanceof Uint8Array)||size+chunk.byteLength>expected.size)return false;for(let offset=0;offset<chunk.byteLength;offset+=65536){check();hash.update(chunk.subarray(offset,offset+65536));}size+=chunk.byteLength;}
  check();return size===expected.size&&hash.digest('hex')===expected.digest;
 }

 async runOnce(signal?:AbortSignal):Promise<IngressResult>{
  if(this.busy)throw new Error('Provider worker is already running');if(signal?.aborted)return 'interrupted';
  const slot=randomUUID(),job=transaction(this.db,()=>{const now=this.clock();if(this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND lease_until>?").get(now))return null;const claim=this.queue.claim(now,30000,'provider.pull');if(claim)this.db.prepare("INSERT INTO worker_slots VALUES('provider-source',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until").run(slot,now+30000);return claim;});
  if(!job)return 'idle';const action=this.actions.forJob(job);let actionApplied=false;this.busy=true;const controller=new AbortController(),abort=()=>controller.abort(new ProviderError('PROVIDER_CANCELLED'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();let adapter:ProviderReader|undefined,heartbeat:ReturnType<typeof setInterval>|undefined,activeSnapshot:string|undefined;
  const owns=()=>{controller.signal.throwIfAborted();const now=this.clock();if(!this.queue.owns(job,now)||!this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND token=? AND lease_until>?").get(slot,now))throw new ProviderError('LEASE_LOST');};
  const complete=(errorCode?:string)=>{owns();transaction(this.db,()=>{if(action)this.actions.finish(job,errorCode);if(!this.queue.complete(job,this.clock()))throw new ProviderError('LEASE_LOST');});};
  try{
   owns();const documentId=job.payload.documentId;if(typeof documentId!=='string'||!documentId||documentId.length>128||Object.keys(job.payload).length!==1)throw new ProviderError('PROVIDER_SOURCE_CHANGED');
   const accepted=this.inbox.appliedForJob(job);if(accepted){await this.inbox.cleanupApplied(accepted.id,job,slot);complete();return 'applied';}
   let previous=this.inbox.latest(documentId);const refreshGoogle=googleIngressPriority(this.db,documentId)&&!!previous&&['conflict','discarded'].includes(previous.state);if(previous?.state==='conflict'&&!action&&transaction(this.db,()=>acknowledgeGoogleMarkdownEcho(this.db,previous!.id,this.clock())))previous=this.inbox.latest(documentId);
   if(previous?.state==='applied'&&previous.lease_job_id===job.id){await this.inbox.cleanupApplied(previous.id,job,slot);complete();return 'applied';}
   if(action){
    if(action.state!=='queued'){complete();return action.state==='done'?'unchanged':'blocked';}
    if(action.kind==='check'&&previous?.lease_job_id===job.id){this.actions.authorize(job,previous.id);activeSnapshot=previous.id;if(['staged','conflict'].includes(previous.state))this.inbox.resume(previous.id,job,slot);}else this.actions.authorize(job);
    if(action.kind==='discard'){
     if(!previous||previous.id!==action.snapshot_id)throw new DocumentError('CONFLICT');
     this.inbox.resume(previous.id,job,slot,this.clock(),true);this.actions.authorize(job);await this.inbox.discard(previous.id,job);complete();return 'discarded';
    }
    if(action.kind==='check'&&previous?.state==='conflict')previous=undefined;
   }
   if(previous?.state==='conflict'&&action?.kind!=='apply'){
    if(!action&&googleIngressPriority(this.db,documentId)){
     // A parked snapshot is only a past observation. Re-read Drive against the
     // current baseline, retaining all local document and Office recovery bytes.
     this.inbox.resume(previous.id,job,slot,this.clock(),true);await this.inbox.discard(previous.id,job);previous=undefined;
    }else{complete();return 'conflict';}
   }
   if(previous?.state==='applied'){
    await this.inbox.cleanupApplied(previous.id,job,slot);
    if(previous.lease_job_id===job.id){complete();return 'applied';}
   }else if(previous&&['pending','receiving','failed','discarding'].includes(previous.state)){
    this.inbox.resume(previous.id,job,slot);await this.inbox.discard(previous.id,job);
   }
   const scope=ingressContext(this.db,documentId),check=()=>{owns();if(action&&!actionApplied)this.actions.authorize(job,activeSnapshot);const current=ingressContext(this.db,documentId);if(current.connection_id!==scope.connection_id||current.connection_revision!==scope.connection_revision||current.binding_generation!==scope.binding_generation)throw new ProviderError('PROVIDER_CONFIG_CHANGED');};let renewAt=this.clock()+10000;
   heartbeat=setInterval(()=>{try{check();const now=this.clock();if(now>=renewAt){transaction(this.db,()=>{check();if(activeSnapshot){this.inbox.renew(activeSnapshot,job,now);return;}if(!this.queue.renew(job,now,30000)||!this.db.prepare("UPDATE worker_slots SET lease_until=? WHERE name='provider-source' AND token=? AND lease_until>?").run(now+30000,slot,now).changes)throw new ProviderError('LEASE_LOST');});renewAt=now+10000;}}catch(error){controller.abort(error);}},250);
   const connection=this.vault.forBinding({documentId,connectionId:scope.connection_id,connectionRevision:scope.connection_revision,bindingGeneration:scope.binding_generation});adapter=await this.resolve(connection);check();const options={check,signal:controller.signal};

   if(previous?.state==='staged'||previous?.state==='conflict'&&action?.kind==='apply'){
    this.inbox.resume(previous.id,job,slot);activeSnapshot=previous.id;
    const remote=await adapter.read(connection.reference,options);check();const capacity=this.capacity(remote);
    if(remote.fingerprint!==previous.observed_fingerprint||capacity.sizingMode!==previous.sizing_mode||(remote.size===null?previous.size!>capacity.declaredSize:remote.size!==previous.size)){this.inbox.park(previous.id,job,'PROVIDER_CONFLICT');complete(action?.kind==='apply'?'PROVIDER_CONFLICT':undefined);return 'conflict';}
    if(!await this.verify(remote.bytes,{digest:previous.digest!,size:previous.size!},check)){this.inbox.park(previous.id,job,'PROVIDER_SOURCE_CHANGED');complete(action?'PROVIDER_SOURCE_CHANGED':undefined);return 'conflict';}
    await this.inbox.commit(previous.id,job,{signal:controller.signal,authorize:action?()=>this.actions.authorize(job,activeSnapshot):undefined});actionApplied=true;await this.inbox.cleanupApplied(previous.id,job);complete();return 'applied';
   }
   if(!refreshGoogle&&adapter.changed&&!await adapter.changed(connection.reference,scope.fingerprint,options)){check();complete();return 'unchanged';}
   const remote=await adapter.read(connection.reference,options);check();const capacity=this.capacity(remote),snapshot=this.inbox.begin({job,slotToken:slot,documentId,connectionRevision:scope.connection_revision,baseLocalRevision:scope.local_revision,baseProviderRevision:scope.provider_revision!,baseFingerprint:scope.fingerprint,observedFingerprint:remote.fingerprint,...capacity,observedAt:this.clock()});
   activeSnapshot=snapshot.id;
   if(snapshot.state==='conflict'||snapshot.state==='staged'){
    const pinned=this.inbox.prepared(snapshot.id,job);
    if(!await this.verify(remote.bytes,{digest:pinned.digest!,size:pinned.size!},check)){this.inbox.park(snapshot.id,job,'PROVIDER_SOURCE_CHANGED');complete(action?'PROVIDER_SOURCE_CHANGED':undefined);return 'conflict';}
    if(snapshot.state==='conflict'){if(!action&&transaction(this.db,()=>acknowledgeGoogleMarkdownEcho(this.db,snapshot.id,this.clock()))){await this.inbox.cleanupApplied(snapshot.id,job);complete();return 'applied';}complete();return 'conflict';}
    await this.inbox.commit(snapshot.id,job,{signal:controller.signal,authorize:action?()=>this.actions.authorize(job,activeSnapshot):undefined});actionApplied=true;await this.inbox.cleanupApplied(snapshot.id,job);complete();return 'applied';
   }
   const staged=await this.inbox.receive(snapshot.id,job,remote.bytes,{signal:controller.signal});check();if(staged.state==='conflict'){if(!action&&transaction(this.db,()=>acknowledgeGoogleMarkdownEcho(this.db,snapshot.id,this.clock()))){await this.inbox.cleanupApplied(snapshot.id,job);complete();return 'applied';}complete();return 'conflict';}
   await this.inbox.commit(snapshot.id,job,{signal:controller.signal,authorize:action?()=>this.actions.authorize(job,activeSnapshot):undefined});actionApplied=true;await this.inbox.cleanupApplied(snapshot.id,job);complete();return 'applied';
  }catch(error){
   const now=this.clock();if(!this.queue.owns(job,now)||controller.signal.aborted||!this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND token=? AND lease_until>?").get(slot,now))return 'interrupted';
   if(error instanceof DocumentError&&['CONFLICT','OFFICE_ACTIVE','SAVE_PENDING'].includes(error.code)){complete(action?error.code:undefined);return 'conflict';}
   if(action&&error instanceof DocumentError&&['SESSION_REQUIRED','ACCESS_DENIED','NOT_FOUND','PROVIDER_CONFIG_CHANGED'].includes(error.code)){complete(error.code);return 'blocked';}
   if(error instanceof DocumentError&&error.code==='INGRESS_QUOTA'){if(action)complete('INGRESS_QUOTA');else this.queue.reject(job,'INGRESS_QUOTA',now);return 'blocked';}
   const safe=error instanceof DocumentError&&error.code==='INGRESS_SCOPE_CHANGED'?new ProviderError('PROVIDER_CONFIG_CHANGED'):safeProviderError(error);
   if(safe.code==='PROVIDER_UNAVAILABLE'){this.queue.fail(job,safe.code,now,60000);return 'deferred';}
   if(action)complete(safe.code);else this.queue.reject(job,safe.code,now);return 'blocked';
  }finally{if(heartbeat)clearInterval(heartbeat);signal?.removeEventListener('abort',abort);if(adapter)try{await adapter.close();}catch{}this.db.prepare("DELETE FROM worker_slots WHERE name='provider-source' AND token=?").run(slot);this.busy=false;}
 }
}
