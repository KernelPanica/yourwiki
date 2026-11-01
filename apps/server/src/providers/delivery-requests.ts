import type {Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {JobQueue} from '../jobs.ts';
/** Join the accepted source transaction; never queue credentials or remote references. */
export function requestSourceDelivery(db:Database,documentId:string,revision:number,now:number):void {
 if(!db.inTransaction)throw new Error('Source delivery requires the source transaction');
 if(!db.prepare('SELECT document_id FROM provider_source_bindings WHERE document_id=?').get(documentId))return;
 db.prepare(`INSERT INTO provider_delivery_requests(document_id,requested_revision,updated_at) VALUES(?,?,?)
 ON CONFLICT(document_id) DO UPDATE SET requested_revision=excluded.requested_revision,updated_at=excluded.updated_at`).run(documentId,revision,now);
 new JobQueue(db).enqueue({kind:'provider.deliver',key:`${documentId}:${revision}`,payload:{documentId,requestedRevision:revision}},now);
}

/** Reuse the editor's existing conflict/recovery contract, never save on exit. */
export function assertSourceDeliveryWritable(db:Database,documentId:string):void {
 if(db.prepare("SELECT 1 FROM provider_delivery_attempts WHERE document_id=? AND state IN ('unknown','retryable','conflict','blocked') LIMIT 1").get(documentId))throw new DocumentError('CONFLICT');
}
