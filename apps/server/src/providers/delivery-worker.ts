import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {transaction,type Database} from '../database.ts';
import {JobQueue} from '../jobs.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {DeliveryAttempts,type DeliveryAttempt} from './delivery-attempts.ts';
import {CredentialVault,type AdapterConnection} from './credential-vault.ts';
import {ProviderError,safeProviderError,type ProviderAdapter} from './adapter.ts';
export type AdapterResolver=(connection:AdapterConnection)=>Promise<ProviderAdapter>;
export type DeliveryResult='idle'|'superseded'|'confirmed'|'unknown'|'retryable'|'conflict'|'blocked'|'deferred'|'interrupted';
/** Dedicated one-slot process; HTTP and preview jobs never perform provider IO. */
export class DeliveryWorker {
 private db:Database;private store:BlobStore;private vault:CredentialVault;private resolve:AdapterResolver;private clock:()=>number;private queue:JobQueue;private attempts:DeliveryAttempts;private busy=false;
 constructor(db:Database,store:BlobStore,vault:CredentialVault,resolve:AdapterResolver,options:{clock?:()=>number}={}){
  if(!vault.belongsToDatabase(db))throw new Error('Provider vault requires the worker database');this.db=db;this.store=store;this.vault=vault;this.resolve=resolve;this.clock=options.clock??Date.now;this.queue=new JobQueue(db);this.attempts=new DeliveryAttempts(db);
 }
 private async *source(attempt:DeliveryAttempt,check:()=>void,signal:AbortSignal){
  check();const stream=await this.store.read(attempt.digest).catch(()=>{throw new ProviderError('PROVIDER_SOURCE_CHANGED');});const abort=()=>stream.destroy(new ProviderError('PROVIDER_CANCELLED'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  try{let size=0;const hash=createHash('sha256');for await(const chunk of stream){check();if(!(chunk instanceof Uint8Array)||size+chunk.byteLength>attempt.size)throw new ProviderError('PROVIDER_SOURCE_CHANGED');size+=chunk.byteLength;hash.update(chunk);yield chunk;}check();if(size!==attempt.size||hash.digest('hex')!==attempt.digest)throw new ProviderError('PROVIDER_SOURCE_CHANGED');}catch(error){const safe=safeProviderError(error);throw safe.code==='PROVIDER_UNAVAILABLE'?new ProviderError('PROVIDER_SOURCE_CHANGED'):safe;}finally{signal.removeEventListener('abort',abort);stream.destroy();}
 }
 async runOnce(signal?:AbortSignal):Promise<DeliveryResult>{
  if(this.busy)throw new Error('Provider worker is already running');if(signal?.aborted)return 'interrupted';
  const slot=randomUUID(),job=transaction(this.db,()=>{const now=this.clock();if(this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND lease_until>?").get(now))return null;this.attempts.recoverExhausted(now);const claim=this.queue.claim(now,30000,['provider.deliver','provider.reconcile']);if(claim)this.db.prepare("INSERT INTO worker_slots VALUES('provider-source',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until").run(slot,now+30000);return claim;});
  if(!job)return 'idle';this.busy=true;const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  let attempt:DeliveryAttempt|null=null,adapter:ProviderAdapter|undefined,writing=false,dispatched=false,heartbeat:ReturnType<typeof setInterval>|undefined;
  const check=()=>{if(controller.signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');const now=this.clock();if(!this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND token=? AND lease_until>?").get(slot,now))throw new ProviderError('LEASE_LOST');if(attempt)this.attempts.check(attempt,now);};
  try{
   attempt=this.attempts.acquire(job,this.clock());if(!attempt)return 'superseded';
   heartbeat=setInterval(()=>{try{transaction(this.db,()=>{check();this.attempts.renew(attempt!,this.clock());const now=this.clock();if(!this.db.prepare("UPDATE worker_slots SET lease_until=? WHERE name='provider-source' AND token=? AND lease_until>?").run(now+30000,slot,now).changes)throw new ProviderError('LEASE_LOST');});}catch{abort();}},10000);
   check();const connection=this.vault.forAttempt(attempt);adapter=await this.resolve(connection);check();
   // Always authenticate actual immutable source bytes, never a cached existence flag.
   for await(const _ of this.source(attempt,check,controller.signal)){}
   if(attempt.state==='unknown'){
    await adapter.retire({operationId:attempt.id,reference:connection.reference,signal:controller.signal});check();const remote=await adapter.read(connection.reference,{signal:controller.signal,check});let size=0;const hash=createHash('sha256');for await(const chunk of remote.bytes){check();if(!(chunk instanceof Uint8Array)||size+chunk.byteLength>4*1024**3)throw new ProviderError('PROVIDER_SOURCE_CHANGED');size+=chunk.byteLength;hash.update(chunk);}check();const digest=hash.digest('hex');if(size!==remote.size)throw new ProviderError('PROVIDER_SOURCE_CHANGED');
    if(digest===attempt.digest&&size===attempt.size){this.attempts.confirm(attempt,{fingerprint:remote.fingerprint,digest,size},this.clock());return 'confirmed';}
    const state=remote.fingerprint===attempt.baseline?'retryable':'conflict';this.attempts.settle(attempt,state,state==='retryable'?'PROVIDER_UNAVAILABLE':'PROVIDER_CONFLICT',this.clock());return state;
   }
   this.attempts.markWriting(attempt,this.clock());writing=true;dispatched=true;
   const receipt=await adapter.replace({operationId:attempt.id,reference:connection.reference,baseline:attempt.baseline,target:{digest:attempt.digest,size:attempt.size},source:this.source(attempt,check,controller.signal),signal:controller.signal,check});
   check();this.attempts.confirm(attempt,receipt,this.clock());return 'confirmed';
  }catch(error){
   const safe=safeProviderError(error),now=this.clock();
   if(!this.queue.owns(job,now))return 'interrupted';
   if(!attempt){const raw=(error as any)?.code;if(raw==='PROVIDER_BUSY')this.queue.fail(job,'PROVIDER_UNAVAILABLE',now,1000);else this.queue.reject(job,safe.code,now);return 'deferred';}
   try{
    const unknown=attempt.state==='unknown'||writing&&dispatched&&(!(error instanceof ProviderError)||error.outcome==='unknown');
    if(unknown){this.attempts.settle(attempt,'unknown','PROVIDER_UNKNOWN',now);return 'unknown';}
    if(!writing&&safe.code==='PROVIDER_UNAVAILABLE'){this.attempts.reschedulePrepared(attempt,now);return 'deferred';}
    const state=safe.code==='PROVIDER_CONFLICT'?'conflict':writing&&['PROVIDER_UNAVAILABLE','PROVIDER_CANCELLED'].includes(safe.code)?'retryable':'blocked';
    const code=state==='conflict'?'PROVIDER_CONFLICT':state==='retryable'?'PROVIDER_UNAVAILABLE':['ACCESS_DENIED','PROVIDER_CONFIG_CHANGED','PROVIDER_SOURCE_CHANGED'].includes(safe.code)?safe.code:'PROVIDER_SOURCE_CHANGED';this.attempts.settle(attempt,state,code,now);return state;
   }catch{return 'interrupted';}
  }finally{
   if(heartbeat)clearInterval(heartbeat);signal?.removeEventListener('abort',abort);if(adapter)try{await adapter.close();}catch{}this.db.prepare("DELETE FROM worker_slots WHERE name='provider-source' AND token=?").run(slot);this.busy=false;
  }
 }
 async run(signal:AbortSignal){while(!signal.aborted){const result=await this.runOnce(signal);if(result==='idle')try{await delay(250,undefined,{signal});}catch{if(!signal.aborted)throw new Error('Provider polling failed');}}}
}
