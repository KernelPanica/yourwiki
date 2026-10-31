import {transaction,type Database} from '../database.ts';
import {authenticateSession,tokenHash} from '../auth/sessions.ts';
import {AccessService} from '../access.ts';
import {OfficeSessions,OfficeError} from './sessions.ts';
type Row={handoff_deadline:number|null;claimed_at:number|null;created_at:number;browser_session_hash:string;open_id:string;document_id:string|null;state:'pending'|'ready'|'cancelled';office_session_id:string|null;capability_hash:string|null};
const openingLeaseMs=180000,handoffLeaseMs=180000;
const validId=(v:string)=>typeof v==='string'&&/^[A-Za-z0-9_-]{16,128}$/.test(v);
/** Cancellation receipts live as long as their issuing parent; they are never time-reused. */
export class OfficeOpenings {
 private db:Database;private office:OfficeSessions;private clock:()=>number;private maxOwn:number;private maxTotal:number;private maxPending:number;private stopped=false;private watches=new Set<()=>void>();
 constructor(db:Database,options:{clock?:()=>number;maxPerParent?:number;maxTotal?:number;maxPending?:number}={}){this.db=db;this.clock=options.clock??Date.now;this.maxOwn=options.maxPerParent??4096;this.maxTotal=options.maxTotal??100000;this.maxPending=options.maxPending??15;if(![this.maxOwn,this.maxTotal,this.maxPending].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('Invalid opening limits');this.office=new OfficeSessions(db,{clock:this.clock});}
 private row(parent:string,id:string){return this.db.prepare('SELECT * FROM office_openings WHERE browser_session_hash=? AND open_id=?').get(parent,id) as Row|undefined;}
 private valid(id:string){if(!validId(id))throw new OfficeError('INVALID_REQUEST');if(this.stopped)throw new OfficeError('OFFICE_CLOSED');}
 private prune(){
  // Delete invalid parents, not just tombstones: a backward clock must not revive a pruned request.
  this.db.prepare(`DELETE FROM sessions WHERE token_hash IN (
   SELECT o.browser_session_hash FROM office_openings o JOIN sessions s ON s.token_hash=o.browser_session_hash JOIN users u ON u.id=s.user_id
   WHERE (s.expires_at<=? OR u.active!=1 OR s.auth_version!=u.auth_version) LIMIT 256)`).run(this.clock());
 }
 private quota(parent:string){
  const own=this.db.prepare('SELECT COUNT(*) AS n FROM office_openings WHERE browser_session_hash=?').get(parent) as {n:number},total=this.db.prepare('SELECT COUNT(*) AS n FROM office_openings').get() as {n:number};if(own.n>=this.maxOwn||total.n>=this.maxTotal)throw new OfficeError('OFFICE_OPEN_LIMIT');
 }
 begin(browserToken:string,id:string,documentId:string){
  this.valid(id);this.cleanup();return transaction(this.db,()=>{
   const actor=authenticateSession(this.db,browserToken,this.clock());if(!actor)throw new OfficeError('SESSION_REQUIRED');
   if(!new AccessService(this.db).allows(actor.userId,documentId,'read')||!this.db.prepare('SELECT 1 FROM documents WHERE id=? AND published_revision IS NOT NULL').get(documentId))throw new OfficeError('NOT_FOUND');
   const old=this.row(actor.tokenHash,id);if(old)throw new OfficeError(old.state==='cancelled'?'OFFICE_OPEN_CANCELLED':'OFFICE_OPEN_REUSED');this.quota(actor.tokenHash);const pending=this.db.prepare("SELECT COUNT(*) AS n FROM office_openings WHERE state='pending'").get() as {n:number};if(pending.n>=this.maxPending)throw new OfficeError('OFFICE_OPEN_LIMIT');
   this.db.prepare("INSERT INTO office_openings(browser_session_hash,open_id,document_id,state,created_at) VALUES(?,?,?,'pending',?)").run(actor.tokenHash,id,documentId,this.clock());return actor.tokenHash;
  });
 }
 assertActive(parent:string,id:string){
  this.valid(id);const actor=this.db.prepare('SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 AND s.auth_version=u.auth_version').get(parent,this.clock());if(!actor)throw new OfficeError('SESSION_REQUIRED');const row=this.row(parent,id);if(!row||row.state==='cancelled'||row.document_id===null||row.state==='pending'&&row.created_at+openingLeaseMs<=this.clock())throw new OfficeError('OFFICE_OPEN_CANCELLED');return row;
 }
 allocate(browserToken:string,id:string,documentId:string,writable:boolean){
  return transaction(this.db,()=>{
   const actor=authenticateSession(this.db,browserToken,this.clock());if(!actor)throw new OfficeError('SESSION_REQUIRED');const row=this.assertActive(actor.tokenHash,id);if(row.state!=='pending'||row.capability_hash!==null||row.document_id!==documentId)throw new OfficeError('OFFICE_OPEN_REUSED');
   this.reapUnused(actor.tokenHash);const opened=this.office.open(browserToken,documentId,writable);this.db.prepare('UPDATE office_openings SET office_session_id=?,capability_hash=? WHERE browser_session_hash=? AND open_id=?').run(opened.sessionId,tokenHash(opened.token),actor.tokenHash,id);return opened;
  });
 }
 finish(parent:string,id:string,requireHandoff=false){
  return transaction(this.db,()=>{
   const row=this.assertActive(parent,id),capability=row.capability_hash?this.db.prepare('SELECT expires_at FROM office_tokens WHERE token_hash=? AND office_session_id=? AND browser_session_hash=? AND expires_at>?').get(row.capability_hash,row.office_session_id,parent,this.clock()) as {expires_at:number}|undefined:undefined;if(row.state!=='pending'||!capability)throw new OfficeError('OFFICE_OPEN_CANCELLED');
   const now=this.clock(),deadline=requireHandoff?Math.min(now+handoffLeaseMs,capability.expires_at):null;this.db.prepare("UPDATE office_openings SET state='ready',handoff_deadline=?,claimed_at=? WHERE browser_session_hash=? AND open_id=?").run(deadline,requireHandoff?null:now,parent,id);return deadline;
  });
 }
 /** Claim only after the caller has validated the complete CheckFileInfo metadata. */
 claim<T>(sessionId:string,token:string,accepted:(actor:ReturnType<OfficeSessions['authorize']>)=>T):T{
  const result=transaction(this.db,()=>{try{
   const actor=this.office.authorize(sessionId,token),hash=tokenHash(token),row=this.db.prepare('SELECT state FROM office_openings WHERE capability_hash=? AND office_session_id=?').get(hash,sessionId) as {state:string}|undefined;if(row?.state==='pending')throw new OfficeError('OFFICE_PREPARING');
   const value=accepted(actor);if(value instanceof OfficeError)return value;
   this.db.prepare("UPDATE office_openings SET claimed_at=COALESCE(claimed_at,?) WHERE capability_hash=? AND office_session_id=? AND state='ready' AND claimed_at IS NULL AND EXISTS(SELECT 1 FROM office_tokens t WHERE t.token_hash=office_openings.capability_hash AND t.office_session_id=office_openings.office_session_id AND t.browser_session_hash=office_openings.browser_session_hash)").run(this.clock(),hash,sessionId);return value;
  }catch(error){if(error instanceof OfficeError)return error;throw error;}});if(result instanceof OfficeError)throw result;return result;
 }

 private cancelRow(parent:string,id:string){
  const row=this.row(parent,id);if(!row)return false;if(row.office_session_id&&row.capability_hash)this.office.revokeOpening(row.office_session_id,row.capability_hash,parent);this.db.prepare("UPDATE office_openings SET state='cancelled' WHERE browser_session_hash=? AND open_id=?").run(parent,id);return true;
 }
 cancelOwned(parent:string,id:string){if(!validId(id))throw new OfficeError('INVALID_REQUEST');transaction(this.db,()=>{this.cancelRow(parent,id);});}
 cancel(csrf:string,id:string){
  this.valid(id);if(typeof csrf!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(csrf))throw new OfficeError('INVALID_REQUEST');
  const proof=tokenHash(csrf),now=this.clock(),retireInvalid=()=>{this.db.prepare('DELETE FROM sessions WHERE csrf_hash=? AND (expires_at<=? OR NOT EXISTS(SELECT 1 FROM users u WHERE u.id=sessions.user_id AND u.active=1 AND u.auth_version=sessions.auth_version))').run(proof,now);};
  if(!this.db.prepare('SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.csrf_hash=? AND s.expires_at>? AND u.active=1 AND s.auth_version=u.auth_version').get(proof,now)){retireInvalid();return;}
  this.cleanup();
  transaction(this.db,()=>{
   const actor=this.db.prepare('SELECT s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.csrf_hash=? AND s.expires_at>? AND u.active=1 AND s.auth_version=u.auth_version').get(proof,now) as {token_hash:string}|undefined;
   if(!actor){retireInvalid();return;} // Retire expired proof parents so clock rollback cannot revive them.
   if(this.cancelRow(actor.token_hash,id))return;this.quota(actor.token_hash);this.db.prepare("INSERT INTO office_openings(browser_session_hash,open_id,state,created_at) VALUES(?,?,'cancelled',?)").run(actor.token_hash,id,this.clock());
  });
 }
 private reapUnused(parent:string|null=null){
  const rows=this.db.prepare("SELECT browser_session_hash,open_id FROM office_openings WHERE state='ready' AND claimed_at IS NULL AND handoff_deadline IS NOT NULL AND handoff_deadline<=? AND (? IS NULL OR browser_session_hash=?) LIMIT 256").all(this.clock(),parent,parent) as Row[];for(const row of rows)this.cancelRow(row.browser_session_hash,row.open_id);
 }

 cleanup(){
  if(this.stopped)return;transaction(this.db,()=>{this.prune();const expired=this.db.prepare("SELECT browser_session_hash,open_id FROM office_openings WHERE state='pending' AND created_at<=? LIMIT 256").all(this.clock()-openingLeaseMs) as Row[];for(const row of expired)this.cancelRow(row.browser_session_hash,row.open_id);this.reapUnused();});
 }

 watch(parent:string,id:string,intervalMs=250){
  this.assertActive(parent,id);if(!Number.isSafeInteger(intervalMs)||intervalMs<10||intervalMs>1000)throw new Error('Invalid opening watch interval');const controller=new AbortController();
  const interval=setInterval(()=>{try{this.assertActive(parent,id);}catch(error){controller.abort(error);stop();}},intervalMs);interval.unref();const stop=()=>{clearInterval(interval);this.watches.delete(close);},close=()=>{controller.abort(new OfficeError('OFFICE_CLOSED'));stop();};this.watches.add(close);return {signal:controller.signal,stop};
 }
 close(){this.stopped=true;for(const close of [...this.watches])close();}
}
