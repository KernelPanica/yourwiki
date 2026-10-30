import {randomUUID} from 'node:crypto';
import {transaction,type Database} from '../database.ts';
import {officeRecoveryAllowed} from './recovery-access.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {OfficeError} from './sessions.ts';
type Row={id:string;author_id:string;document_id:string;office_session_id:string;state:string;digest:string|null;size:number|null;reserved_bytes:number;declared_size:number|null;lease_until:number};
export class OfficeIngressMaintenance {
 private stop=new AbortController();private claims=new Set<Promise<unknown>>();
 private db:Database;private store:BlobStore;private clock:()=>number;private cleaning:Promise<{cleaned:number;recovered:number;failed:number}>|undefined;
 constructor(db:Database,store:BlobStore,clock:()=>number){this.db=db;this.store=store;this.clock=clock;}
 private row(id:string){return this.db.prepare('SELECT * FROM office_ingress WHERE id=?').get(id) as Row|undefined;}
 private eligible(row:Row){return row.state==='receiving'?row.lease_until<=this.clock():row.state==='committed'||row.state==='discarded'||(row.state==='failed'&&row.digest===null);}
 cleanupExpired(){if(this.stop.signal.aborted)return Promise.resolve({cleaned:0,recovered:0,failed:0});return this.cleaning??=this.run().finally(()=>{this.cleaning=undefined;});}
 async close(){this.stop.abort(new OfficeError('OFFICE_CLOSED'));await Promise.allSettled([this.cleaning,...this.claims]);}
 async discard(userId:string,id:string){
  this.stop.signal.throwIfAborted();
  transaction(this.db,()=>{
   const row=this.row(id);if(!row||!officeRecoveryAllowed(this.db,userId,row))throw new OfficeError('NOT_FOUND');
   if(row.state==='committed')return;
   this.db.prepare("UPDATE office_ingress SET state='discarded',error_code='OFFICE_WRITE_DISCARDED' WHERE id=?").run(id);
   this.db.prepare("UPDATE save_operations SET cancelled_at=? WHERE id=? AND author_id=? AND state!='saved'").run(this.clock(),id,row.author_id);
   this.db.prepare("UPDATE office_sessions SET pending_operation_id=NULL,error_code=CASE WHEN superseded=1 THEN error_code ELSE NULL END WHERE id=? AND pending_operation_id=?").run(row.office_session_id,id);
  });
  await this.cleanupExpired();await this.reclaim(id);
 }
 private async run(){
  const deadline=AbortSignal.timeout(120000),signal=AbortSignal.any([this.stop.signal,deadline]);
  signal.throwIfAborted();
  const ids=new Set((this.db.prepare("SELECT id FROM office_ingress WHERE (state='receiving' AND lease_until<=?) OR (state='failed' AND digest IS NULL AND reserved_bytes>0) LIMIT 32").all(this.clock()) as {id:string}[]).map(row=>row.id));
  // Inspect actual namespaces too: a stale producer may have recreated a failed namespace after a prior cleanup.
  for await(const id of this.store.uploadNamespaces()){if(signal.aborted)break;const row=this.row(id);if(row&&this.eligible(row))ids.add(id);if(ids.size>=64)break;}
  const result={cleaned:0,recovered:0,failed:0};
  for(const id of ids){if(signal.aborted)break;try{const outcome=await this.reclaim(id,signal);if(outcome)result[outcome]++;}catch{result.failed++;}}
  return result;
 }
 private reclaim(id:string,signal?:AbortSignal):Promise<'cleaned'|'recovered'|null>{
  if(this.stop.signal.aborted)return Promise.resolve(null);
  const task=this.reclaimOne(id,signal);this.claims.add(task);task.then(()=>this.claims.delete(task),()=>this.claims.delete(task));return task;
 }
 private async reclaimOne(id:string,parent?:AbortSignal):Promise<'cleaned'|'recovered'|null>{
  this.stop.signal.throwIfAborted();parent?.throwIfAborted();
  const token=randomUUID();const row=transaction(this.db,()=>{
   let row=this.row(id);if(!row||!this.eligible(row))return null;
   const claimed=this.db.prepare(`INSERT INTO office_ingress_cleanup(id,token,lease_until) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until WHERE office_ingress_cleanup.lease_until<=?`).run(id,token,this.clock()+120000,this.clock());
   if(!claimed.changes)return null;
   if(row.state==='receiving'){this.db.prepare("UPDATE office_ingress SET state='failed',error_code='OFFICE_WRITE_LEASE_LOST' WHERE id=?").run(id);row=this.row(id)!;}
   return row;
  });if(!row)return null;
  const controller=new AbortController(),heartbeat=setInterval(()=>{
   try{if(this.db.prepare('UPDATE office_ingress_cleanup SET lease_until=? WHERE id=? AND token=? AND lease_until>?').run(this.clock()+120000,id,token,this.clock()).changes!==1)controller.abort();}catch{controller.abort();}
  },30000),deadline=setTimeout(()=>controller.abort(),120000);
  const signal=AbortSignal.any([controller.signal,this.stop.signal,...(parent?[parent]:[])]);
  const owns=()=>!signal.aborted&&!!this.db.prepare('SELECT 1 FROM office_ingress_cleanup WHERE id=? AND token=? AND lease_until>?').get(id,token,this.clock());
  try{
   signal.throwIfAborted();const namespace=await this.store.existingUploadStore(id);signal.throwIfAborted();
   if(namespace&&row.state==='failed'&&row.digest===null){
    const completed=[];for await(const blob of namespace.completedBlobs()){signal.throwIfAborted();completed.push(blob);if(completed.length>1)throw new OfficeError('OFFICE_RECOVERY_AMBIGUOUS');}
    const blob=completed[0];
    if(blob){
     if(blob.size>row.reserved_bytes||!await namespace.verify(blob,signal))throw new OfficeError('OFFICE_RECOVERY_CORRUPT');
     signal.throwIfAborted();await namespace.syncPrepared(blob);signal.throwIfAborted();
     const recovered=transaction(this.db,()=>{
      if(!owns())throw new OfficeError('OFFICE_WRITE_LEASE_LOST');const current=this.row(id);if(current?.state!=='failed'||current.digest!==null)return false;
      const mismatch=current.declared_size!==null&&current.declared_size!==blob.size;
      this.db.prepare('UPDATE office_ingress SET state=?,digest=?,size=?,reserved_bytes=?,error_code=? WHERE id=?').run(mismatch?'failed':'prepared',blob.digest,blob.size,blob.size,mismatch?'OFFICE_SIZE_MISMATCH':'OFFICE_RECOVERED_UNVALIDATED',id);return true;
     });if(recovered)return 'recovered';
    }
   }
   if(!owns())throw new OfficeError('OFFICE_WRITE_LEASE_LOST');const current=this.row(id);if(!current||!this.eligible(current))return null;
   signal.throwIfAborted();await this.store.removeUpload(id);signal.throwIfAborted();
   transaction(this.db,()=>{if(!owns())throw new OfficeError('OFFICE_WRITE_LEASE_LOST');this.db.prepare("UPDATE office_ingress SET reserved_bytes=0 WHERE id=? AND (state IN ('committed','discarded') OR (state='failed' AND digest IS NULL))").run(id);});return 'cleaned';
  }catch(error){
   if(owns()&&error instanceof OfficeError)this.db.prepare("UPDATE office_ingress SET error_code=? WHERE id=? AND state='failed' AND digest IS NULL").run(error.code,id);
   throw error;
  }finally{clearInterval(heartbeat);clearTimeout(deadline);this.db.prepare('DELETE FROM office_ingress_cleanup WHERE id=? AND token=?').run(id,token);}
 }
}
