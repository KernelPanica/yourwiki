import type {Database} from '../database.ts';
/** Only internal office commits may bypass the other-editor fence. */
export function officeWriteAllowed(db:Database,documentId:string,sessionId:string|undefined,now:number){
 if(sessionId)return !!db.prepare('SELECT 1 FROM office_sessions o JOIN documents d ON d.id=o.document_id JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision WHERE o.id=? AND o.document_id=? AND o.superseded=0 AND o.expires_at>? AND o.base_revision=d.local_revision AND o.base_digest=v.digest').get(sessionId,documentId,now);
 return !db.prepare('SELECT 1 FROM office_sessions WHERE document_id=? AND (expires_at>? OR pending_operation_id IS NOT NULL) LIMIT 1').get(documentId,now);
}
