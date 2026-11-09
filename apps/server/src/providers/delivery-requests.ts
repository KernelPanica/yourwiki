import {googleLifecyclePending} from './google-lifecycle-guard.ts';
import type {Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {JobQueue} from '../jobs.ts';
/** Join the accepted source transaction; never queue credentials or remote references. */
export function requestSourceDelivery(db:Database,documentId:string,revision:number,now:number):void {
 if(!db.inTransaction)throw new Error('Source delivery requires the source transaction');
 if(!db.prepare('SELECT document_id FROM provider_source_bindings WHERE document_id=?').get(documentId))return;
 const jobId=new JobQueue(db).enqueue({kind:'provider.deliver',key:`${documentId}:${revision}`,payload:{documentId,requestedRevision:revision}},now);
 db.prepare(`INSERT INTO provider_delivery_requests(document_id,requested_revision,updated_at,delivery_job_id) VALUES(?,?,?,?)
 ON CONFLICT(document_id) DO UPDATE SET requested_revision=excluded.requested_revision,updated_at=excluded.updated_at,delivery_job_id=excluded.delivery_job_id`).run(documentId,revision,now,jobId);
}

/** Reuse the editor's existing conflict/recovery contract, never save on exit. */
export function assertSourceDeliveryWritable(db:Database,documentId:string,now=Date.now()):void {
 if(db.prepare("SELECT 1 FROM google_storage_exports WHERE document_id=? AND state!='confirmed'").get(documentId))throw new DocumentError('CONFLICT');
 if(googleLifecyclePending(db,documentId))throw new DocumentError('CONFLICT');
 if(db.prepare("SELECT 1 FROM provider_delivery_attempts a JOIN jobs j ON j.id=a.lease_job_id WHERE a.document_id=? AND (a.state IN ('unknown','retryable','conflict','blocked') OR (a.state='writing' AND (a.lease_until<=? OR j.state!='running' OR COALESCE(j.lease_until,0)<=?))) LIMIT 1").get(documentId,now,now))throw new DocumentError('CONFLICT');
}
