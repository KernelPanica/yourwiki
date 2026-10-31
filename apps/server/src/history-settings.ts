import {transaction,type Database} from './database.ts';
import {DocumentError} from './document-errors.ts';
type Policy={enabled:number;revision:number;byteLimit:number;entryLimit:number};
export function historyPolicy(db:Database){return db.prepare('SELECT history_enabled AS enabled,history_settings_revision AS revision,history_byte_limit AS byteLimit,history_entry_limit AS entryLimit FROM app_state WHERE id=1').get() as Policy;}
export class HistorySettings{
 private db:Database;private clock:()=>number;
 constructor(db:Database,options:{clock?:()=>number}={}){this.db=db;this.clock=options.clock??Date.now;}
 private admin(userId:string){const actor=this.db.prepare('SELECT active,admin_role,display_name FROM users WHERE id=?').get(userId) as {active:number;admin_role:string;display_name:string}|undefined;if(!actor?.active||!['giga','simple'].includes(actor.admin_role))throw new DocumentError('ACCESS_DENIED');return actor;}
 read(userId:string){this.admin(userId);const policy=historyPolicy(this.db);return {...policy,enabled:policy.enabled===1};}
 update(userId:string,input:{enabled:boolean;baseRevision:number}){
  if(typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.baseRevision)||input.baseRevision<0)throw new DocumentError('INVALID_REQUEST');
  return transaction(this.db,()=>{const actor=this.admin(userId),before=historyPolicy(this.db);if(before.revision!==input.baseRevision)throw new DocumentError('CONFLICT');if(before.enabled===(input.enabled?1:0))return {...before,enabled:input.enabled};
   this.db.prepare('UPDATE app_state SET history_enabled=?,history_settings_revision=history_settings_revision+1 WHERE id=1').run(input.enabled?1:0);
   this.db.prepare('INSERT INTO history_settings_changes(revision,enabled,author_id,author_name,created_at) VALUES(?,?,?,?,?)').run(before.revision+1,input.enabled?1:0,userId,actor.display_name,this.clock());return this.read(userId);
  });
 }
}
