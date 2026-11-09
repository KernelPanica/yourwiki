import {GoogleReconciliationWorker} from './google-reconciliation.ts';
import {randomUUID} from 'node:crypto';
import {transaction,type Database} from '../database.ts';
import {JobQueue} from '../jobs.ts';
import {SecretConfigs} from './secret-config.ts';
import {GoogleAuthPool} from './google-auth-pool.ts';
import {GoogleDiscoveryRequests,googleDiscoveryJobKind} from './google-discovery-jobs.ts';
import {GoogleDiscoveryReader} from './google-discovery.ts';
import {googleManagedRecipients} from './google-grants.ts';
import {ProviderError} from './adapter.ts';
/** Read-only discovery jobs share the existing global provider source slot. */
export class GoogleDiscoveryWorker{
 private reconciliation:GoogleReconciliationWorker;private db:Database;private configs:SecretConfigs;private queue:JobQueue;private requests:GoogleDiscoveryRequests;private auth:GoogleAuthPool;private clock:()=>number;private request:typeof fetch;private lifetime=new AbortController();private running:Promise<string>|undefined;private ownsAuth=true;
 constructor(db:Database,configs:SecretConfigs,options:{fetch?:typeof fetch;clock?:()=>number;authPool?:GoogleAuthPool}={}){this.db=db;this.reconciliation=new GoogleReconciliationWorker(db,configs,options);this.configs=configs;this.queue=new JobQueue(db);this.clock=options.clock??Date.now;this.request=options.fetch??fetch;this.requests=new GoogleDiscoveryRequests(db,configs,{clock:this.clock});if(options.authPool&&!options.authPool.belongsToDatabase(db))throw new Error('Google auth pool requires the worker database');this.ownsAuth=!options.authPool;this.auth=options.authPool??new GoogleAuthPool(db,configs,options);}
 runOnce(signal?:AbortSignal):Promise<string>{if(this.running)throw new Error('Discovery worker is already running');if(signal?.aborted||this.lifetime.signal.aborted)return Promise.resolve('idle');const work=this.run(signal).then(result=>result==='idle'?this.reconciliation.runOnce(AbortSignal.any([this.lifetime.signal,...(signal?[signal]:[])])):result).finally(()=>{if(this.running===work)this.running=undefined;});this.running=work;return work;}
 private async run(parent?:AbortSignal):Promise<string>{
  const slot=randomUUID(),job=transaction(this.db,()=>{const now=this.clock();if(this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND lease_until>?").get(now))return null;const job=this.queue.claim(now,30000,googleDiscoveryJobKind);if(job)this.db.prepare("INSERT INTO worker_slots VALUES('provider-source',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until").run(slot,now+30000);return job;});if(!job)return 'idle';
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,this.lifetime.signal,...(parent?[parent]:[])]);let reader:GoogleDiscoveryReader|undefined;
  const owns=()=>{if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');const now=this.clock();if(!this.queue.owns(job,now)||!this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND token=? AND lease_until>?").get(slot,now))throw new ProviderError('LEASE_LOST');};
  const timer=setInterval(()=>{try{transaction(this.db,()=>{owns();this.requests.scope(job);if(!this.queue.renew(job,this.clock(),30000)||this.db.prepare("UPDATE worker_slots SET lease_until=? WHERE name='provider-source' AND token=?").run(this.clock()+30000,slot).changes!==1)throw new ProviderError('LEASE_LOST');});}catch{controller.abort();}},10000);
  try{
   owns();const initial=this.requests.scope(job),{connection_id:id,connection_revision:revision}=initial.row;
   const root=()=>{const row=this.db.prepare('SELECT encrypted_config FROM provider_connections WHERE id=? AND revision=? AND enabled=1').get(id,revision) as {encrypted_config:string}|undefined;if(!row)throw new ProviderError('PROVIDER_CONFIG_CHANGED');try{return this.configs.decrypt(row.encrypted_config).root;}catch{throw new ProviderError('PROVIDER_CONFIG_CHANGED');}};const pinned=root();if(typeof pinned!=='string')throw new ProviderError('PROVIDER_CONFIG_CHANGED');
   const check=()=>{owns();this.requests.scope(job);if(root()!==pinned)throw new ProviderError('PROVIDER_CONFIG_CHANGED');};
   reader=new GoogleDiscoveryReader(pinned,{access:options=>this.auth.access(id,revision,options),invalidate:token=>this.auth.invalidate(id,revision,token)},async reference=>{check();return googleManagedRecipients(this.db,id,revision,reference);},{fetch:this.request});
   const page=await reader.page({...(initial.folderId?{folderId:initial.folderId}:{}),...(initial.pageToken?{pageToken:initial.pageToken}:{})},{signal,check});check();this.requests.publish(job,page);return 'discovered';
  }catch(error){if(signal.aborted||!this.queue.owns(job,this.clock()))return 'interrupted';const raw=error&&typeof error==='object'&&'code' in error?(error as {code:unknown}).code:undefined;const allowed=['ACCESS_DENIED','PROVIDER_CONFIG_CHANGED','PROVIDER_SOURCE_CHANGED','PROVIDER_CONFLICT','PROVIDER_INVALID_REFERENCE','PROVIDER_UNAVAILABLE'];const code=typeof raw==='string'&&allowed.includes(raw)?raw:'PROVIDER_UNAVAILABLE';if(code==='PROVIDER_UNAVAILABLE')this.queue.fail(job,code,this.clock(),60000);else this.queue.reject(job,code,this.clock());return code==='PROVIDER_UNAVAILABLE'?'deferred':'blocked';}
  finally{clearInterval(timer);if(reader)await reader.close();this.db.prepare("DELETE FROM worker_slots WHERE name='provider-source' AND token=?").run(slot);}
 }
 async close(){this.lifetime.abort();await Promise.allSettled([this.running]);await this.reconciliation.close();await Promise.allSettled([this.ownsAuth?this.auth.close():Promise.resolve()]);}
}
