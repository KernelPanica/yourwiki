import {transaction,type Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
/** Keep recipient evidence only until Drive confirms removal. No network IO here. */
export class UserPurge{
 private db:Database;
 constructor(db:Database){this.db=db;}
 detach(id:string){return transaction(this.db,()=>{if(!this.db.prepare('SELECT 1 FROM users WHERE id=? AND purged_at IS NOT NULL').get(id))throw new DocumentError('INVALID_REQUEST');
  const identity=this.db.prepare('SELECT email FROM provider_google_identities WHERE user_id=?').get(id) as {email:string}|undefined;
  if(identity&&!this.db.prepare('SELECT 1 FROM provider_google_identities i JOIN users u ON u.id=i.user_id WHERE i.user_id!=? AND lower(i.email)=? AND i.active=1 AND u.active=1 AND u.purged_at IS NULL').get(id,identity.email.toLowerCase())){
   const recipient=identity.email.toLowerCase();this.db.prepare("INSERT INTO user_google_purge_cleanup(user_id,recipient,created_at) VALUES(?,?,?) ON CONFLICT(user_id) DO NOTHING").run(id,recipient,Date.now());
   this.db.prepare("UPDATE provider_google_grants SET desired_role='',state=CASE WHEN state='unknown' THEN state ELSE 'pending' END,checked_at=0 WHERE recipient=?").run(recipient);
  }
  for(const table of ['sessions','office_tokens','provider_google_identity_states','provider_google_original_sessions','provider_google_connect_states','google_registration_attempts','memberships','user_invite_groups','user_preferences','document_presence','document_visits','provider_google_identities'])this.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(id);
  this.db.prepare('DELETE FROM password_reset_links WHERE user_id=? OR creator_id=?').run(id,id);
  this.db.prepare('UPDATE invitations SET revoked=1 WHERE creator_id=?').run(id);
  const path='$.'+JSON.stringify(id);this.db.prepare('UPDATE resources SET user_policies=json_remove(user_policies,?) WHERE json_type(user_policies,?) IS NOT NULL').run(path,path);
  this.db.prepare("UPDATE local_trash SET name='Deleted user',details='{}' WHERE kind='user' AND object_id=?").run(id);
  this.db.exec('UPDATE app_state SET acl_epoch=acl_epoch+1 WHERE id=1');
  return {googleCleanup:(this.db.prepare("SELECT 1 FROM user_google_purge_cleanup WHERE user_id=? AND state!='complete'").get(id)?'pending':'complete') as 'pending'|'complete'};
 });}
 static fenced(db:Database,recipient:string){return !!db.prepare("SELECT 1 FROM user_google_purge_cleanup WHERE recipient=? AND state!='complete'").get(recipient);}
 /** Called by the existing provider worker; confirmed-empty grants are the erasure receipt. */
 refresh(){return transaction(this.db,()=>{
  if(this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND lease_until>?").get(Date.now()))return;
  const recipients=this.db.prepare("SELECT recipient FROM user_google_purge_cleanup WHERE recipient IS NOT NULL AND state!='complete' GROUP BY recipient ORDER BY min(checked_at),min(created_at) LIMIT 16").all() as {recipient:string}[];
  for(const {recipient} of recipients){this.db.prepare('UPDATE user_google_purge_cleanup SET checked_at=? WHERE recipient=?').run(Date.now(),recipient);
   const refs=this.db.prepare("SELECT reference FROM provider_google_grants WHERE recipient=? UNION SELECT reference FROM provider_google_grant_imports WHERE lower(recipient)=?").all(recipient,recipient) as {reference:string}[];
   let pending=false,error:string|null=null;
   for(const {reference} of refs){
    const grant=this.db.prepare('SELECT state,applied_role,permission_id,pending_action,error_code FROM provider_google_grants WHERE reference=? AND recipient=?').get(reference,recipient) as {state:string;applied_role:string;permission_id:string|null;pending_action:string|null;error_code:string|null}|undefined;
    if(grant?.state==='synced'&&grant.applied_role===''&&grant.permission_id===null&&grant.pending_action===null)continue;
    pending=true;
    if(!this.db.prepare("SELECT 1 FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.reference=? AND c.provider='google' AND c.enabled=1").get(reference))error='PROVIDER_CONFIG_CHANGED';
    else if(grant?.applied_role==='owner')error='GOOGLE_OWNER_ACCESS';
    else if(grant?.state==='failed'||grant?.error_code)error=grant.error_code??'PROVIDER_UNAVAILABLE';
   }
   if(pending){this.db.prepare('UPDATE user_google_purge_cleanup SET state=?,error_code=? WHERE recipient=?').run(error?'blocked':'pending',error,recipient);continue;}
   // The trigger permits only this confirmed, one-way privacy redaction of legacy receipts.
   this.db.prepare("UPDATE user_google_purge_cleanup SET state='complete',error_code=NULL,completed_at=? WHERE recipient=?").run(Date.now(),recipient);
   this.db.prepare("UPDATE provider_google_grant_imports SET recipient='',legacy_user_key=NULL,desired_role='',applied_role='',permission_id='',status='revoked',attempted_at=NULL WHERE lower(recipient)=?").run(recipient);
   this.db.prepare('DELETE FROM provider_google_grants WHERE recipient=?').run(recipient);
   this.db.prepare('UPDATE user_google_purge_cleanup SET recipient=NULL WHERE recipient=?').run(recipient);
  }
 });}
 status(){return {items:this.db.prepare("SELECT user_id AS userId,state,error_code AS errorCode,created_at AS createdAt,completed_at AS completedAt FROM user_google_purge_cleanup ORDER BY CASE state WHEN 'blocked' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,created_at DESC LIMIT 100").all() as {userId:string;state:string;errorCode:string|null;createdAt:number;completedAt:number|null}[],counts:this.db.prepare('SELECT state,count(*) AS count FROM user_google_purge_cleanup GROUP BY state').all() as {state:string;count:number}[]};}
 retry(){return transaction(this.db,()=>{this.db.exec("UPDATE provider_google_grants SET checked_at=0,state=CASE WHEN state='unknown' THEN state ELSE 'pending' END,error_code=NULL WHERE recipient IN(SELECT recipient FROM user_google_purge_cleanup WHERE state!='complete');UPDATE user_google_purge_cleanup SET state='pending',error_code=NULL WHERE state!='complete'");return {scheduled:true};});}
}
