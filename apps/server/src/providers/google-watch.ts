import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {transaction,type Database} from '../database.ts';
import {GoogleAuthPool} from './google-auth-pool.ts';
import {GoogleControlHttp} from './google-control-http.ts';
import {SecretConfigs} from './secret-config.ts';
import {ProviderError} from './adapter.ts';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
/** Notification content is untrusted: only advance the existing verified pull schedule. */
export function registerGoogleWatch(app:FastifyInstance,db:Database){
 app.register(async scoped=>{
 scoped.removeContentTypeParser('application/json');
 scoped.addContentTypeParser('application/json',{parseAs:'buffer'},(_request,_body,done)=>done(null,null));
 scoped.post('/api/providers/google/notifications',{bodyLimit:1024},(request,reply)=>{
  const h=request.headers,id=h['x-goog-channel-id'],token=h['x-goog-channel-token'],resource=h['x-goog-resource-id'],number=h['x-goog-message-number'],state=h['x-goog-resource-state'];
  if(typeof id==='string'&&id.length<=64&&typeof token==='string'&&token.length===43&&typeof resource==='string'&&resource.length<=512&&typeof number==='string'&&/^[1-9][0-9]{0,19}$/.test(number)&&['sync','update','trash','untrash','remove'].includes(String(state))){transaction(db,()=>{
   const now=Date.now(),row=db.prepare("SELECT w.* FROM provider_google_watches w JOIN provider_source_bindings b ON b.document_id=w.document_id JOIN provider_connections c ON c.id=b.connection_id JOIN resources r ON r.id=b.document_id WHERE w.channel_id=? AND (w.expires_at>? OR (w.expires_at=0 AND w.retry_at>?)) AND w.connection_id=b.connection_id AND w.connection_revision=c.revision AND w.binding_generation=b.generation AND w.reference=b.reference AND c.enabled=1 AND r.trashed=0").get(id,now,now) as any;
   if(!row||(row.resource_id!==resource&&!(state==='sync'&&row.resource_id===null))||!timingSafeEqual(Buffer.from(row.token_hash,'hex'),Buffer.from(hash(token),'hex'))||BigInt(number)<=BigInt(row.last_number))return;
   db.prepare('UPDATE provider_google_watches SET last_number=? WHERE document_id=?').run(number,row.document_id);
   if(state==='sync'){db.prepare('UPDATE provider_google_watches SET resource_id=?,notified_at=? WHERE document_id=?').run(resource,now,row.document_id);return;}
   if(now-row.notified_at<750)return;
   db.prepare('UPDATE provider_google_watches SET notified_at=? WHERE document_id=?').run(now,row.document_id);
   db.prepare('UPDATE provider_sync_checks SET due_at=MIN(due_at,?) WHERE document_id=?').run(now,row.document_id);
  });}
  return reply.code(204).send();
 });
 });
}
type Source={document_id:string;connection_id:string;revision:number;generation:number;reference:string};
/** One metadata-only watch registration per turn, one shared provider source lease.
 * No arbitrary callback origin, file mutations, downloads or replay of unknown POSTs. */
export class GoogleWatchWorker{
 private db:Database;private pool:GoogleAuthPool;private own:boolean;private url:string|null=null;private fetch?:typeof fetch;private clock:()=>number;private lifetime=new AbortController();private running?:Promise<string>;private scanAt=0;
 constructor(db:Database,configs:SecretConfigs,publicUrl:string|undefined,options:{authPool?:GoogleAuthPool;fetch?:typeof fetch;clock?:()=>number}={}){this.db=db;this.pool=options.authPool??new GoogleAuthPool(db,configs,{fetch:options.fetch});this.own=!options.authPool;this.fetch=options.fetch;this.clock=options.clock??Date.now;try{const u=new URL(publicUrl??'');if(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&!u.search&&u.pathname==='/')this.url=u.origin+'/api/providers/google/notifications';}catch{/* Non-public installations retain polling. */}}
 runOnce(parent?:AbortSignal):Promise<string>{if(this.running)return Promise.resolve('idle');const run=this.perform(parent).finally(()=>{if(this.running===run)this.running=undefined;});this.running=run;return run;}
 private async perform(parent?:AbortSignal){if(!this.url||this.lifetime.signal.aborted||parent?.aborted||this.clock()<this.scanAt)return 'idle';const db=this.db,now=this.clock(),slot=randomUUID();const source=transaction(db,()=>{
  if(db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND lease_until>?").get(now))return null;
  const row=db.prepare("SELECT b.document_id,b.connection_id,c.revision,b.generation,b.reference FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id JOIN resources r ON r.id=b.document_id LEFT JOIN provider_google_watches w ON w.document_id=b.document_id WHERE c.provider='google' AND c.enabled=1 AND r.trashed=0 AND (w.document_id IS NULL OR w.connection_id!=b.connection_id OR w.connection_revision!=c.revision OR w.binding_generation!=b.generation OR w.reference!=b.reference OR (w.expires_at<? AND w.retry_at<=?)) ORDER BY COALESCE(w.retry_at,0),b.document_id LIMIT 1").get(now+3600000,now) as Source|undefined;
  if(row)db.prepare("INSERT INTO worker_slots VALUES('provider-source',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until").run(slot,now+45000);return row;
 });if(!source){this.scanAt=now+30000;return 'idle';}
 const signal=AbortSignal.any([this.lifetime.signal,...(parent?[parent]:[])]),check=()=>{if(signal.aborted||!db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND token=? AND lease_until>?").get(slot,this.clock())||!db.prepare("SELECT 1 FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=? AND b.connection_id=? AND b.generation=? AND b.reference=? AND c.revision=? AND c.enabled=1").get(source.document_id,source.connection_id,source.generation,source.reference,source.revision))throw new ProviderError('PROVIDER_CONFIG_CHANGED');};
 const http=new GoogleControlHttp({access:s=>this.pool.access(source.connection_id,source.revision,s),invalidate:t=>this.pool.invalidate(source.connection_id,source.revision,t)},{fetch:this.fetch}),channel=randomUUID(),token=randomBytes(32).toString('base64url');
 try{check();transaction(db,()=>{db.prepare("INSERT INTO provider_google_watches(document_id,connection_id,connection_revision,binding_generation,reference,channel_id,token_hash,retry_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET connection_id=excluded.connection_id,connection_revision=excluded.connection_revision,binding_generation=excluded.binding_generation,reference=excluded.reference,channel_id=excluded.channel_id,token_hash=excluded.token_hash,resource_id=NULL,expires_at=0,retry_at=excluded.retry_at,last_number='0',notified_at=0").run(source.document_id,source.connection_id,source.revision,source.generation,source.reference,channel,hash(token),now+60000);});const value=await http.call('POST','files/'+source.reference+'/watch',{supportsAllDrives:'true'},{id:channel,type:'web_hook',address:this.url,token,expiration:String(now+86400000)},{signal,check,beforeDispatch:check});check();const synchronized=db.prepare('SELECT resource_id FROM provider_google_watches WHERE document_id=? AND channel_id=?').get(source.document_id,channel) as {resource_id:string|null}|undefined;const expiry=Number(value.expiration);if(!synchronized||synchronized.resource_id!==null&&synchronized.resource_id!==value.resourceId||value.id!==channel||typeof value.resourceId!=='string'||!/^[\x21-\x7e]{1,512}$/.test(value.resourceId)||!Number.isSafeInteger(expiry)||expiry<=this.clock()||expiry>now+86460000)throw new ProviderError('PROVIDER_UNAVAILABLE');db.prepare('UPDATE provider_google_watches SET resource_id=?,expires_at=?,retry_at=?,failures=0,error_code=NULL WHERE document_id=? AND channel_id=?').run(value.resourceId,expiry,expiry-3600000,source.document_id,channel);return 'watching';
 }catch(error){db.prepare('UPDATE provider_google_watches SET error_code=?,failures=MIN(failures+1,6),retry_at=?+MIN(3600000,60000*(1<<MIN(failures,6))) WHERE document_id=? AND channel_id=?').run(error instanceof ProviderError?error.code:'PROVIDER_UNAVAILABLE',this.clock(),source.document_id,channel);return 'deferred';}
 finally{await http.close();db.prepare("DELETE FROM worker_slots WHERE name='provider-source' AND token=?").run(slot);}
 }
 async close(){this.lifetime.abort();await this.running;if(this.own)await this.pool.close();}
}
