import type {Database} from '../database.ts';
import {AccessService} from '../access.ts';
/** Recovery bytes belong to their author; only a current giga admin may act for another author. */
export function officeRecoveryAllowed(db:Database,userId:string,row:{author_id:string;document_id:string}){
 const user=db.prepare('SELECT active,admin_role FROM users WHERE id=?').get(userId) as {active:number;admin_role:string}|undefined;
 return !!user&&user.active===1&&(row.author_id===userId||user.admin_role==='giga')&&new AccessService(db).allows(userId,row.document_id,'read');
}
