import type {Database} from '../../apps/server/src/database.ts';
type User={id:string;username:string;display_name:string;password_hash:string;admin_role:string;active:number;trashed_at:number|null};
const exists=(db:Database,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
/** Run against backed-up, offline staging copies. No passwords or identities leave the server. */
export function migrateYourwikiAccounts(wiki:Database,space:Database,issuer:string,now=Date.now(),mapping:Record<string,string>={}){
 if(wiki.pragma('application_id',{simple:true})!==0x5957494b||space.pragma('application_id',{simple:true})!==0x59535043)throw Error('FOREIGN_DATABASE');
 if(!exists(wiki,'yourspace_identities'))throw Error('SSO_SCHEMA_REQUIRED');
 // This importer deliberately handles the deployed legacy schema. A new credential format needs its own reviewed adapter.
 if(exists(wiki,'user_second_factor')&&(wiki.prepare('SELECT count(*) n FROM user_second_factor').get() as {n:number}).n)throw Error('SECOND_FACTOR_ADAPTER_REQUIRED');
 const users=wiki.prepare('SELECT id,username,display_name,password_hash,admin_role,active,trashed_at FROM users WHERE purged_at IS NULL ORDER BY id').all() as User[];
 const receipts=exists(space,'yourwiki_account_imports');
 const plan=users.map(u=>{
  if(!/^[\p{L}\p{N}_.@-]{2,64}$/u.test(u.username)||!['giga','simple','member'].includes(u.admin_role)||!/^pbkdf2_sha256\$1000000\$/.test(u.password_hash))throw Error('UNSUPPORTED_ACCOUNT:'+u.id);
  const previous=receipts?space.prepare('SELECT subject FROM yourwiki_account_imports WHERE wiki_user_id=? AND issuer=?').get(u.id,issuer) as {subject:string}|undefined:undefined;
  if(previous){if(!space.prepare('SELECT 1 FROM users WHERE id=?').get(previous.subject))throw Error('IMPORT_RECEIPT_BROKEN');return {u,subject:previous.subject,create:false};}
  if(mapping[u.id]){if(!space.prepare('SELECT 1 FROM users WHERE id=? AND active=1 AND erased_at IS NULL').get(mapping[u.id]))throw Error('MAPPED_ACCOUNT_MISSING');return {u,subject:mapping[u.id]!,create:false};}
  if(space.prepare('SELECT 1 FROM users WHERE id=? OR username=? COLLATE NOCASE').get(u.id,u.username))throw Error('IDENTITY_COLLISION:'+u.id);
  return {u,subject:u.id,create:true};
 });
 const google=exists(wiki,'provider_google_identities')?wiki.prepare('SELECT user_id,subject,email,verified_at FROM provider_google_identities WHERE active=1').all() as {user_id:string;subject:string;email:string;verified_at:number}[]:[];
 for(const g of google){const row=plan.find(p=>p.u.id===g.user_id);if(!row)continue;const match=space.prepare('SELECT user_id FROM google_links WHERE subject=? OR user_id=?').get(g.subject,row.subject) as {user_id:string}|undefined;if(match&&match.user_id!==row.subject)throw Error('GOOGLE_IDENTITY_COLLISION:'+row.u.id);}
 for(const p of plan){const old=wiki.prepare('SELECT user_id,subject FROM yourspace_identities WHERE issuer=? AND (subject=? OR user_id=?)').get(issuer,p.subject,p.u.id) as {user_id:string;subject:string}|undefined;if(old&&(old.user_id!==p.u.id||old.subject!==p.subject))throw Error('WIKI_IDENTITY_COLLISION');}
 const targets=plan.map(p=>[p.u.id,p.subject]);
 space.transaction(()=>{
  space.exec('CREATE TABLE IF NOT EXISTS yourwiki_account_imports(wiki_user_id TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL REFERENCES users(id),imported_at INTEGER NOT NULL,PRIMARY KEY(wiki_user_id,issuer),UNIQUE(issuer,subject))');
  for(const {u,subject,create} of plan){if(create){
   const active=u.active===1&&u.trashed_at===null?1:0,role=u.admin_role==='giga'?'superadmin':u.admin_role==='simple'?'admin':'member';
   space.prepare('INSERT INTO users(id,username,display_name,password_hash,role,active,created_at,deactivated_at) VALUES(?,?,?,?,?,?,NULL,?)').run(subject,u.username,u.display_name,u.password_hash,role,active,active?null:u.trashed_at??now);
   space.prepare('UPDATE users SET created_at=NULL WHERE id=?').run(subject);
   }
   space.prepare('INSERT INTO yourwiki_account_imports VALUES(?,?,?,?) ON CONFLICT(wiki_user_id,issuer) DO NOTHING').run(u.id,issuer,subject,now);
   space.prepare('INSERT INTO security_log(created_at,action,subject_id,details) VALUES(?,?,?,?)').run(now,create?'account.imported.yourwiki':'account.linked.yourwiki',subject,JSON.stringify({wikiUserId:u.id,createdAtUnknown:create}));
  }
  for(const g of google){const row=plan.find(p=>p.u.id===g.user_id);if(row?.create)space.prepare('INSERT INTO google_links(user_id,subject,email,linked_at) VALUES(?,?,?,?)').run(row.subject,g.subject,g.email,g.verified_at);}
 })();
 wiki.transaction(()=>{for(const [id,subject] of targets){const old=wiki.prepare('SELECT user_id FROM yourspace_identities WHERE issuer=? AND subject=?').get(issuer,subject) as {user_id:string}|undefined;if(old&&old.user_id!==id)throw Error('WIKI_IDENTITY_COLLISION');wiki.prepare('INSERT INTO yourspace_identities(issuer,subject,user_id) VALUES(?,?,?) ON CONFLICT(issuer,subject) DO NOTHING').run(issuer,subject,id);}})();
 if((wiki.pragma('foreign_key_check') as unknown[]).length||(space.pragma('foreign_key_check') as unknown[]).length)throw Error('FOREIGN_KEY_FAILURE');
 return {created:plan.filter(p=>p.create).length,linked:plan.length,google:google.filter(g=>plan.some(p=>p.u.id===g.user_id&&p.create)).length};
}
