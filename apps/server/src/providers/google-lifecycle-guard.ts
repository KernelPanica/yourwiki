import type {Database} from '../database.ts';
/** A metadata move owns the same original until its remote result and local destination agree. */
export function googleLifecyclePending(db:Database,documentId:string):boolean{
 return !!db.prepare("SELECT 1 FROM provider_google_operations WHERE document_id=? AND action='move' AND state NOT IN ('confirmed','failed') LIMIT 1").get(documentId);
}
