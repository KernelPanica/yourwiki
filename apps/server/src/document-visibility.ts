import type {Database} from './database.ts';
/** Call after the local read ACL check. Preview generation is not source admission.
 * Unpublished local drafts remain private; confirmed remote sources are already
 * admitted to the shared library and must not vanish after conversion errors. */
export function documentSourceVisible(db:Database,userId:string,id:string,published:number|null){
 if(published!==null)return true;
 const row=db.prepare(`SELECT r.owner_id,u.admin_role,
 EXISTS(SELECT 1 FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id
 WHERE b.document_id=d.id AND b.confirmed_revision>=d.local_revision AND c.enabled=1) AS confirmed,
 EXISTS(SELECT 1 FROM dashboard_local_file x WHERE x.document_id=d.id) AS dashboard
 FROM documents d JOIN resources r ON r.id=d.id JOIN users u ON u.id=? WHERE d.id=?`).get(userId,id) as {owner_id:string;admin_role:string;confirmed:number;dashboard:number}|undefined;
 return !!row&&(row.owner_id===userId||row.admin_role!=='member'||!!row.confirmed||!!row.dashboard);
}
