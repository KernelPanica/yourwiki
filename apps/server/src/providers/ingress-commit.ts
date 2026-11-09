import {JobQueue} from '../jobs.ts';
import {supportsGoogleBinary} from './google-markdown-write.ts';
import {acknowledgeGoogleMarkdownEcho} from './google-markdown-conflict-repair.ts';
import type {Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {captureProviderSourceHistory} from '../history-capture.ts';
import {stagePreviewRequest} from '../preview-request.ts';
import {stageProviderOrigin} from './version-origins.ts';
import {ingressGuard,googleIngressPriority} from './ingress-guards.ts';
import type {IngressRow} from './ingress-inbox.ts';
export type IngressReceipt={snapshotId:string;documentId:string;revision:number;changed:boolean;previewJobId:string|null};
/** A verified read of the exact confirmed bytes is metadata churn, even when
 * Drive adds checksum/head fields and changes the metadata hash. The reader
 * authenticates root, reference and stable bytes before this transaction. */
function unchangedConfirmedGoogleBytes(db:Database,row:IngressRow):boolean{
 if(row.base_local_revision<=row.base_provider_revision||!googleIngressPriority(db,row.document_id))return false;
 const base=db.prepare('SELECT d.format,v.digest,v.size FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=? WHERE d.id=?').get(row.base_provider_revision,row.document_id) as {format:string;digest:string;size:number}|undefined;
 if(!base||base.digest!==row.digest||base.size!==row.size||!supportsGoogleBinary(base.format,row.base_fingerprint)||!supportsGoogleBinary(base.format,row.observed_fingerprint))return false;
 try{const before=JSON.parse(row.base_fingerprint),after=JSON.parse(row.observed_fingerprint);if(before[0]==='rclone-drive-v1'&&after[0]==='rclone-drive-v1')return before[1]===after[1]&&before[2]===after[2]&&before[3]===after[3];return before[1]===after[1]&&[before[3],after[3]].every(hash=>typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash));}catch{return false;}
}
/** Only called after owned immutable bytes were verified/adopted, within the current lease transaction. */
export function commitIngressSnapshot(db:Database,row:IngressRow,now:number,converterVersion:string):IngressReceipt|{error:string}{
 if(!db.inTransaction||!row.digest||row.size===null)throw new Error('Ingress commit requires prepared bytes and a transaction');
 const metadataOnly=unchangedConfirmedGoogleBytes(db,row);
 const echo=metadataOnly?null:acknowledgeGoogleMarkdownEcho(db,row.id,now);if(echo)return echo;
 const latest=db.prepare('SELECT generation FROM provider_ingress_snapshots WHERE document_id=? ORDER BY generation DESC LIMIT 1').get(row.document_id) as {generation:number};
 const reason=latest.generation!==row.generation?'CONFLICT':ingressGuard(db,row,now);
 if(reason){db.prepare("UPDATE provider_ingress_snapshots SET state='conflict',error_code=?,updated_at=? WHERE id=?").run(reason,now,row.id);db.prepare("INSERT INTO events(kind,document_id,payload,created_at) VALUES('provider.ingress',?,'{}',?)").run(row.document_id,now);return {error:reason};}
 const changed=!metadataOnly&&row.digest!==row.base_digest,revision=metadataOnly?row.base_provider_revision:row.base_local_revision+(changed?1:0);let previewJobId:string|null=null;
 // Invalidate stale editors in the same acceptance transaction. Their immutable
 // versions, staged payloads and recovery pointers are deliberately retained.
 if(changed&&googleIngressPriority(db,row.document_id)){
  db.prepare("UPDATE office_sessions SET superseded=1,error_code='CONFLICT',lock_value='',lock_expires_at=0 WHERE document_id=? AND superseded=0").run(row.document_id);
  db.prepare("UPDATE office_openings SET state='cancelled' WHERE document_id=? AND (state='pending' OR (state='ready' AND claimed_at IS NULL))").run(row.document_id);
 }
 if(changed){
  const previous=db.prepare('SELECT created_at FROM document_versions WHERE document_id=? AND revision=?').get(row.document_id,row.base_local_revision) as {created_at:number};
  const createdAt=Math.max(now,previous.created_at+1);if(!Number.isSafeInteger(createdAt)||!Number.isSafeInteger(revision))throw new DocumentError('INVALID_INGRESS');
  captureProviderSourceHistory(db,row.document_id,row.digest,createdAt);
  stageProviderOrigin(db,{documentId:row.document_id,revision,connectionId:row.connection_id,fingerprint:row.observed_fingerprint,observedAt:row.observed_at});
  db.prepare('INSERT INTO document_versions(document_id,revision,digest,size,author_id,created_at) VALUES(?,?,?,?,NULL,?)').run(row.document_id,revision,row.digest,row.size,createdAt);
  db.prepare('UPDATE documents SET local_revision=?,provider_revision=? WHERE id=?').run(revision,revision,row.document_id);
  previewJobId=stagePreviewRequest(db,row.document_id,revision,converterVersion,now);
 }
 if(!changed&&!metadataOnly&&googleIngressPriority(db,row.document_id))db.prepare('UPDATE documents SET provider_revision=? WHERE id=?').run(revision,row.document_id);
 db.prepare('UPDATE provider_source_bindings SET fingerprint=?,confirmed_revision=? WHERE document_id=?').run(row.observed_fingerprint,revision,row.document_id);
 const receipt:IngressReceipt={snapshotId:row.id,documentId:row.document_id,revision,changed,previewJobId};
 db.prepare("UPDATE provider_ingress_snapshots SET state='applied',receipt=?,error_code=NULL,updated_at=? WHERE id=?").run(JSON.stringify(receipt),now,row.id);
 if(googleIngressPriority(db,row.document_id)){
  const attempts=db.prepare("SELECT id FROM provider_delivery_attempts WHERE document_id=? AND state IN ('conflict','retryable','blocked') AND baseline=? AND base_revision=? AND binding_generation=? AND connection_revision=?").all(row.document_id,row.base_fingerprint,row.base_provider_revision,row.binding_generation,row.connection_revision) as {id:string}[];
  for(const attempt of attempts){
   db.prepare('INSERT INTO provider_ingress_supersessions VALUES(?,?,?)').run(attempt.id,row.id,now);
   db.prepare("UPDATE provider_delivery_attempts SET state='retired',updated_at=? WHERE id=?").run(now,attempt.id);
  }
 }
 if(metadataOnly){
  const pending=db.prepare('SELECT requested_revision FROM provider_delivery_requests WHERE document_id=?').get(row.document_id) as {requested_revision:number}|undefined;
  if(pending?.requested_revision===row.base_local_revision){
   const jobId=new JobQueue(db).enqueue({kind:'provider.deliver',key:`${row.document_id}:metadata:${row.id}`,payload:{documentId:row.document_id,requestedRevision:pending.requested_revision}},now);
   db.prepare('UPDATE provider_delivery_requests SET delivery_job_id=?,updated_at=? WHERE document_id=?').run(jobId,now,row.document_id);
  }
 }
 db.prepare("INSERT INTO events(kind,document_id,payload,created_at) VALUES('provider.ingress',?,'{}',?)").run(row.document_id,now);
 return receipt;
}
