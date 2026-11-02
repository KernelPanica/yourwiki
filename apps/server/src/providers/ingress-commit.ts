import type {Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {captureProviderSourceHistory} from '../history-capture.ts';
import {stagePreviewRequest} from '../preview-request.ts';
import {stageProviderOrigin} from './version-origins.ts';
import {ingressGuard} from './ingress-guards.ts';
import type {IngressRow} from './ingress-inbox.ts';
export type IngressReceipt={snapshotId:string;documentId:string;revision:number;changed:boolean;previewJobId:string|null};
/** Only called after owned immutable bytes were verified/adopted, within the current lease transaction. */
export function commitIngressSnapshot(db:Database,row:IngressRow,now:number,converterVersion:string):IngressReceipt|{error:string}{
 if(!db.inTransaction||!row.digest||row.size===null)throw new Error('Ingress commit requires prepared bytes and a transaction');
 const latest=db.prepare('SELECT generation FROM provider_ingress_snapshots WHERE document_id=? ORDER BY generation DESC LIMIT 1').get(row.document_id) as {generation:number};
 const reason=latest.generation!==row.generation?'CONFLICT':ingressGuard(db,row,now);
 if(reason){db.prepare("UPDATE provider_ingress_snapshots SET state='conflict',error_code=?,updated_at=? WHERE id=?").run(reason,now,row.id);db.prepare("INSERT INTO events(kind,document_id,payload,created_at) VALUES('provider.ingress',?,'{}',?)").run(row.document_id,now);return {error:reason};}
 const changed=row.digest!==row.base_digest,revision=row.base_local_revision+(changed?1:0);let previewJobId:string|null=null;
 if(changed){
  const previous=db.prepare('SELECT created_at FROM document_versions WHERE document_id=? AND revision=?').get(row.document_id,row.base_local_revision) as {created_at:number};
  const createdAt=Math.max(now,previous.created_at+1);if(!Number.isSafeInteger(createdAt)||!Number.isSafeInteger(revision))throw new DocumentError('INVALID_INGRESS');
  captureProviderSourceHistory(db,row.document_id,row.digest,createdAt);
  stageProviderOrigin(db,{documentId:row.document_id,revision,connectionId:row.connection_id,fingerprint:row.observed_fingerprint,observedAt:row.observed_at});
  db.prepare('INSERT INTO document_versions(document_id,revision,digest,size,author_id,created_at) VALUES(?,?,?,?,NULL,?)').run(row.document_id,revision,row.digest,row.size,createdAt);
  db.prepare('UPDATE documents SET local_revision=?,provider_revision=? WHERE id=?').run(revision,revision,row.document_id);
  previewJobId=stagePreviewRequest(db,row.document_id,revision,converterVersion,now);
 }
 db.prepare('UPDATE provider_source_bindings SET fingerprint=?,confirmed_revision=? WHERE document_id=?').run(row.observed_fingerprint,revision,row.document_id);
 const receipt:IngressReceipt={snapshotId:row.id,documentId:row.document_id,revision,changed,previewJobId};
 db.prepare("UPDATE provider_ingress_snapshots SET state='applied',receipt=?,error_code=NULL,updated_at=? WHERE id=?").run(JSON.stringify(receipt),now,row.id);
 db.prepare("INSERT INTO events(kind,document_id,payload,created_at) VALUES('provider.ingress',?,'{}',?)").run(row.document_id,now);
 return receipt;
}
