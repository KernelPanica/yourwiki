import {randomBytes} from 'node:crypto';
import {transaction,type Database} from '../database.ts';
import {authenticateSession,tokenHash} from '../auth/sessions.ts';
import {AccessService} from '../access.ts';
import {OfficeSessions,OfficeError} from './sessions.ts';
/** Correlation metadata only; editor success/dirty messages are never host save receipts. */
export class OfficeSaveIntents {
 private db:Database;private clock:()=>number;private office:OfficeSessions;private maxPending:number;
 constructor(db:Database,options:{clock?:()=>number;maxPending?:number}={}){this.db=db;this.clock=options.clock??Date.now;this.office=new OfficeSessions(db,{clock:this.clock});this.maxPending=options.maxPending??32;if(!Number.isSafeInteger(this.maxPending)||this.maxPending<1||this.maxPending>1000)throw new Error('Invalid intent limit');}
 private actor(browser:string){const actor=authenticateSession(this.db,browser,this.clock());if(!actor)throw new OfficeError('SESSION_REQUIRED');return actor;}
 issue(browser:string,sessionId:string,capability:string){return transaction(this.db,()=>{
  const actor=this.actor(browser),editor=this.office.authorize(sessionId,capability),now=this.clock();
  if(editor.userId!==actor.userId||!this.db.prepare('SELECT 1 FROM office_tokens WHERE token_hash=? AND office_session_id=? AND browser_session_hash=?').get(tokenHash(capability),sessionId,actor.tokenHash))throw new OfficeError('NOT_FOUND');
  if(!editor.write)throw new OfficeError('ACCESS_DENIED');if(editor.session.superseded)throw new OfficeError('CONFLICT');
  this.db.prepare('DELETE FROM office_save_intents WHERE tag IN (SELECT tag FROM office_save_intents WHERE expires_at<=? ORDER BY expires_at LIMIT 256)').run(now);
  const pending=(this.db.prepare('SELECT COUNT(*) AS n FROM office_save_intents WHERE browser_session_hash=? AND confirmed=0 AND expires_at>?').get(actor.tokenHash,now) as {n:number}).n,total=(this.db.prepare('SELECT COUNT(*) AS n FROM office_save_intents').get() as {n:number}).n;
  if(pending>=this.maxPending||total>=100000)throw new OfficeError('OFFICE_SAVE_INTENT_LIMIT');
  const tag='yourwiki-save-'+randomBytes(24).toString('base64url'),expiresAt=Math.min(now+3600000,actor.expiresAt);this.db.prepare('INSERT INTO office_save_intents(tag,office_session_id,browser_session_hash,author_id,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(tag,sessionId,actor.tokenHash,actor.userId,now,expiresAt);
  return {tag,expiresAt,baseRevision:editor.session.base_revision};
 });}
 status(browser:string,sessionId:string,tag:string){return transaction(this.db,()=>{
  const actor=this.actor(browser),intent=this.db.prepare('SELECT expires_at FROM office_save_intents WHERE tag=? AND office_session_id=? AND browser_session_hash=? AND author_id=?').get(tag,sessionId,actor.tokenHash,actor.userId) as {expires_at:number}|undefined;
  if(!intent)throw new OfficeError('NOT_FOUND');if(intent.expires_at<=this.clock())throw new OfficeError('OFFICE_SAVE_INTENT_EXPIRED');
  const room=this.db.prepare('SELECT s.document_id,s.base_revision,s.superseded,s.expires_at,d.local_revision FROM office_sessions s JOIN documents d ON d.id=s.document_id WHERE s.id=?').get(sessionId) as {document_id:string;base_revision:number;superseded:number;expires_at:number;local_revision:number}|undefined;
  if(!room||!new AccessService(this.db).allows(actor.userId,room.document_id,'read'))throw new OfficeError('NOT_FOUND');
  const committed=this.db.prepare("SELECT id,committed_revision FROM office_ingress WHERE office_session_id=? AND client_tag=? AND state='committed' AND committed_revision IS NOT NULL ORDER BY rowid ASC LIMIT 1").get(sessionId,tag) as {id:string;committed_revision:number}|undefined;
  const last=this.db.prepare('SELECT id,state,error_code FROM office_ingress WHERE office_session_id=? AND client_tag=? ORDER BY rowid DESC LIMIT 1').get(sessionId,tag) as {id:string;state:string;error_code:string|null}|undefined;
  if(committed)this.db.prepare('UPDATE office_save_intents SET confirmed=1 WHERE tag=? AND confirmed=0').run(tag);
  return {tag,state:committed?'saved' as const:last&&(last.error_code||['failed','discarded'].includes(last.state))?'failed' as const:'pending' as const,operationId:committed?.id??last?.id??null,revision:committed?.committed_revision??null,currentRevision:room.local_revision,changed:!!room.superseded||room.base_revision!==room.local_revision,expired:room.expires_at<=this.clock(),errorCode:committed?null:last?.error_code??null,delivery:'local' as const,providerDelivery:'not_attempted' as const};
 });}
}
