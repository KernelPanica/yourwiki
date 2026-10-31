import {randomUUID} from 'node:crypto';
import {transaction,type Database} from './database.ts';
import {DocumentError} from './document-errors.ts';
import type {BlobStore,BlobRef} from './storage/blobs.ts';
/** One cross-process disk/hash pass; no persisted or browser-provided integrity proof. */
export class HistoryIntegrity{
 private db:Database;private timeoutMs:number;private closed=false;private active=new Set<AbortController>();private pending=new Set<Promise<void>>();
 constructor(db:Database,options:{timeoutMs?:number}={}){this.db=db;this.timeoutMs=options.timeoutMs??3600000;if(!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>3600000)throw new Error('Invalid history integrity deadline');}
 verify(store:BlobStore,value:BlobRef,signal:AbortSignal,authorize:()=>void){
  if(this.closed)return Promise.reject(new DocumentError('HISTORY_CLOSED'));const task=this.run(store,{...value},signal,authorize);this.pending.add(task);void task.then(()=>this.pending.delete(task),()=>this.pending.delete(task));return task;
 }
 private async run(store:BlobStore,blob:BlobRef,external:AbortSignal,authorize:()=>void){
  external.throwIfAborted();authorize();const token=randomUUID(),controller=new AbortController();
  const claimed=transaction(this.db,()=>{const now=Date.now();if(this.db.prepare("SELECT 1 FROM worker_slots WHERE name='history-integrity' AND lease_until>?").get(now))return false;this.db.prepare("INSERT INTO worker_slots(name,token,lease_until) VALUES('history-integrity',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until").run(token,now+30000);return true;});
  if(!claimed)throw new DocumentError('HISTORY_BUSY');this.active.add(controller);const signal=AbortSignal.any([external,controller.signal]);let renewAt=Date.now()+10000;
  const owns=()=>!!this.db.prepare("SELECT 1 FROM worker_slots WHERE name='history-integrity' AND token=? AND lease_until>?").get(token,Date.now());
  const check=()=>{signal.throwIfAborted();authorize();if(!owns())throw new DocumentError('HISTORY_VERIFY_LEASE_LOST');};
  const watch=setInterval(()=>{try{check();if(Date.now()>=renewAt){const now=Date.now();if(this.db.prepare("UPDATE worker_slots SET lease_until=? WHERE name='history-integrity' AND token=? AND lease_until>?").run(now+30000,token,now).changes!==1)throw new DocumentError('HISTORY_VERIFY_LEASE_LOST');renewAt=now+10000;}}catch(error){controller.abort(error);}},250);
  const deadline=setTimeout(()=>controller.abort(new DocumentError('HISTORY_VERIFY_TIMEOUT')),this.timeoutMs);
  try{
   let valid:boolean;try{valid=await store.verify(blob,signal);}catch(error){signal.throwIfAborted();if(error instanceof DocumentError)throw error;throw new DocumentError('HISTORY_UNAVAILABLE');}
   check();if(!valid)throw new DocumentError('HISTORY_CORRUPT');
  }finally{clearInterval(watch);clearTimeout(deadline);this.active.delete(controller);this.db.prepare("DELETE FROM worker_slots WHERE name='history-integrity' AND token=?").run(token);}
 }
 async close(){this.closed=true;for(const controller of this.active)controller.abort(new DocumentError('HISTORY_CLOSED'));await Promise.allSettled([...this.pending]);}
}
