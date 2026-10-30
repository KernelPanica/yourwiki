import {randomUUID,randomBytes} from 'node:crypto';
import {AccessService} from '../access.ts';
import {authenticateSession,tokenHash} from '../auth/sessions.ts';
import {transaction,type Database} from '../database.ts';
import {officeFormats} from './formats.ts';
export class OfficeError extends Error {code:string;constructor(code:string){super(code);this.code=code;}}
export type OfficeSession={id:string;document_id:string;base_revision:number;base_digest:string;expires_at:number;superseded:number;lock_value:string;lock_expires_at:number;pending_operation_id:string|null;error_code:string|null};
const lease=30*60_000,tokenLifetime=8*3600_000;
export class OfficeSessions {
 private db:Database;private access:AccessService;private clock:()=>number;
 constructor(db:Database,options:{clock?:()=>number}={}){this.db=db;this.access=new AccessService(db);this.clock=options.clock??Date.now;}
 private row(id:string){return this.db.prepare('SELECT * FROM office_sessions WHERE id=?').get(id) as OfficeSession|undefined;}
 private original(documentId:string){return this.db.prepare('SELECT d.local_revision,d.published_revision,d.format,v.digest FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision WHERE d.id=?').get(documentId) as {local_revision:number;published_revision:number|null;format:string;digest:string}|undefined;}
 private refresh(row:OfficeSession){
  const current=this.original(row.document_id);
  if(!row.superseded&&(!current||current.local_revision!==row.base_revision||current.digest!==row.base_digest)){
   this.db.prepare("UPDATE office_sessions SET superseded=1,error_code='CONFLICT' WHERE id=?").run(row.id);row=this.row(row.id)!;
  }
  return row;
 }
 open(browserToken:string,documentId:string,writable=true){
  return transaction(this.db,()=>{
   const now=this.clock(),actor=authenticateSession(this.db,browserToken,now);
   if(!actor)throw new OfficeError('SESSION_REQUIRED');
   const original=this.original(documentId);
   if(!original||original.published_revision===null||!this.access.allows(actor.userId,documentId,'read'))throw new OfficeError('NOT_FOUND');
   if(!officeFormats.has(original.format))throw new OfficeError('UNSUPPORTED_OFFICE_FORMAT');
   let row=this.db.prepare('SELECT * FROM office_sessions WHERE document_id=? AND superseded=0').get(documentId) as OfficeSession|undefined;
   if(row)row=this.refresh(row);
   if(row&&!row.superseded&&row.expires_at<=now&&!row.pending_operation_id){this.db.prepare('UPDATE office_sessions SET superseded=1 WHERE id=?').run(row.id);row=undefined;}
   if(row&&!row.superseded&&row.expires_at<=now&&row.pending_operation_id)this.db.prepare('DELETE FROM office_tokens WHERE office_session_id=?').run(row.id);
   if(!row||row.superseded){
    const id=randomUUID();this.db.prepare('INSERT INTO office_sessions(id,document_id,base_revision,base_digest,expires_at,created_at) VALUES(?,?,?,?,?,?)').run(id,documentId,original.local_revision,original.digest,now+lease,now);row=this.row(id)!;
   }
   const tokens=this.db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN browser_session_hash=? THEN 1 ELSE 0 END),0) AS own FROM office_tokens WHERE expires_at>?').get(actor.tokenHash,now) as {total:number;own:number};
   if(tokens.total>=4096||tokens.own>=64)throw new OfficeError('OFFICE_LIMIT');
   const token=randomBytes(32).toString('base64url'),expiresAt=Math.min(now+tokenLifetime,actor.expiresAt),write=writable===true&&this.access.allows(actor.userId,documentId,'write');
   this.db.prepare('INSERT INTO office_tokens(token_hash,office_session_id,user_id,browser_session_hash,writable,expires_at) VALUES(?,?,?,?,?,?)').run(tokenHash(token),row.id,actor.userId,actor.tokenHash,Number(write),expiresAt);
   this.db.prepare('UPDATE office_sessions SET expires_at=? WHERE id=?').run(now+lease,row.id);
   return {sessionId:row.id,token,expiresAt,write};
  });
 }
 authorize(sessionId:string,token:string){
  return transaction(this.db,()=>{
   const now=this.clock();if(typeof token!=='string'||!(/^[A-Za-z0-9_-]{43}$/).test(token))throw new OfficeError('INVALID_OFFICE_TOKEN');
   const capability=this.db.prepare(`SELECT t.user_id,t.writable FROM office_tokens t JOIN sessions s ON s.token_hash=t.browser_session_hash AND s.user_id=t.user_id JOIN users u ON u.id=t.user_id
    WHERE t.token_hash=? AND t.office_session_id=? AND t.expires_at>? AND s.expires_at>? AND s.auth_version=u.auth_version AND u.active=1`).get(tokenHash(token),sessionId,now,now) as {user_id:string;writable:number}|undefined;
   if(!capability)throw new OfficeError('INVALID_OFFICE_TOKEN');
   let row=this.row(sessionId);if(!row)throw new OfficeError('INVALID_OFFICE_TOKEN');
   if(row.expires_at<=now)throw new OfficeError('OFFICE_EXPIRED');
   if(!this.access.allows(capability.user_id,row.document_id,'read'))throw new OfficeError('ACCESS_DENIED');
   row=this.refresh(row);this.db.prepare('UPDATE office_sessions SET expires_at=? WHERE id=?').run(now+lease,row.id);row.expires_at=now+lease;
   return {session:row,userId:capability.user_id,write:capability.writable===1&&this.access.allows(capability.user_id,row.document_id,'write'),export:this.access.allows(capability.user_id,row.document_id,'export')};
  });
 }
 status(browserToken:string,sessionId:string){
  return transaction(this.db,()=>{
   const now=this.clock(),actor=authenticateSession(this.db,browserToken,now);if(!actor)throw new OfficeError('SESSION_REQUIRED');
   let row=this.row(sessionId);if(!row||!this.access.allows(actor.userId,row.document_id,'read'))throw new OfficeError('NOT_FOUND');
   row=this.refresh(row);const expired=row.expires_at<=now;
   if(!expired)this.db.prepare('UPDATE office_sessions SET expires_at=? WHERE id=?').run(now+lease,row.id);
   const canExport=this.access.allows(actor.userId,row.document_id,'export');
   const pending=row.pending_operation_id?this.db.prepare('SELECT author_id FROM save_operations WHERE id=? AND document_id=? AND office_session_id=?').get(row.pending_operation_id,row.document_id,row.id) as {author_id:string}|undefined:undefined;
   return {sessionId:row.id,documentId:row.document_id,expired,changed:row.superseded===1,errorCode:row.error_code,
    write:!expired&&!row.superseded&&this.access.allows(actor.userId,row.document_id,'write'),export:canExport,
    recovery:canExport&&!!pending&&(pending.author_id===actor.userId||actor.adminRole==='giga')};
  });
 }
 lock(sessionId:string,token:string,operation:string,value='',old?:string):{status:number;lock?:string}{
  const result=transaction(this.db,()=>{
   const actor=this.authorize(sessionId,token),row=actor.session;
   if(!actor.write)throw new OfficeError('ACCESS_DENIED');if(row.superseded)return new OfficeError('CONFLICT');
   const now=this.clock(),current=row.lock_expires_at>now?row.lock_value:'';
   if(operation==='GET_LOCK')return {status:200,lock:current};
   if(!['LOCK','UNLOCK','REFRESH_LOCK'].includes(operation))throw new OfficeError('UNSUPPORTED_OFFICE_OPERATION');
   if(!value||value.length>1024||/[^\x20-\x7e]/.test(value)||(old!==undefined&&(!old||old.length>1024||/[^\x20-\x7e]/.test(old))))throw new OfficeError('INVALID_OFFICE_LOCK');
   const mismatch=operation==='LOCK'?(old!==undefined?(!current||current!==old):(!!current&&current!==value)):(!current||current!==value);
   if(mismatch)return {status:409,lock:current};
   this.db.prepare('UPDATE office_sessions SET lock_value=?,lock_expires_at=? WHERE id=?').run(operation==='UNLOCK'?'':value,now+lease,row.id);
   return {status:200};
  });
  if(result instanceof OfficeError)throw result;return result;
 }
}
