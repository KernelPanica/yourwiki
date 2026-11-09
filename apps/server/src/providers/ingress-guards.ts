import {googleLifecyclePending} from './google-lifecycle-guard.ts';
import type {Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {providerOriginContext} from './version-origins.ts';
import {officeWriteAllowed} from '../office/fence.ts';
import {officeOpeningBlocksExternalChange} from '../office/openings.ts';
export type IngressBaseline={document_id:string;connection_id:string;connection_revision:number;binding_generation:number;base_local_revision:number;base_provider_revision:number;base_digest:string;base_fingerprint:string};
/** Trusted mirror capability only; never imports provider ACL or impersonates a user. */
export function ingressContext(db:Database,id:string){
 try{const doc=providerOriginContext(db,id),binding=db.prepare('SELECT b.connection_id,b.generation,b.fingerprint,c.enabled,c.revision FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=?').get(id) as any;if(!binding?.enabled||doc.provider_revision===null)throw new Error();const version=db.prepare('SELECT digest FROM document_versions WHERE document_id=? AND revision=?').get(id,doc.local_revision) as {digest:string}|undefined;if(!version)throw new Error();return {...doc,connection_id:binding.connection_id,binding_generation:binding.generation,fingerprint:binding.fingerprint,connection_revision:binding.revision,digest:version.digest};}catch{throw new DocumentError('INGRESS_SCOPE_CHANGED');}
}
/** Drive changes take priority; immutable local versions and Office recoveries remain retained. */
export function googleIngressPriority(db:Database,documentId:string):boolean{
 return !!db.prepare("SELECT 1 FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=? AND c.provider='google' AND c.enabled=1").get(documentId);
}
/** Source acceptance policy, separate from permission to finish a private read snapshot. */
export function ingressGuard(db:Database,base:IngressBaseline,now:number):'CONFLICT'|'OFFICE_ACTIVE'|'SAVE_PENDING'|null{
 if(googleLifecyclePending(db,base.document_id))return 'CONFLICT';
 const current=ingressContext(db,base.document_id),drivePriority=googleIngressPriority(db,base.document_id);if(current.connection_id!==base.connection_id||current.connection_revision!==base.connection_revision||current.binding_generation!==base.binding_generation)throw new DocumentError('INGRESS_SCOPE_CHANGED');
 if(current.local_revision!==base.base_local_revision||current.provider_revision!==base.base_provider_revision||current.digest!==base.base_digest||current.fingerprint!==base.base_fingerprint||!drivePriority&&current.local_revision!==current.provider_revision)return 'CONFLICT';
 if(db.prepare(drivePriority?"SELECT 1 FROM provider_delivery_attempts WHERE document_id=? AND state IN ('prepared','writing','unknown') LIMIT 1":"SELECT 1 FROM provider_delivery_attempts WHERE document_id=? AND state NOT IN ('confirmed','retired') LIMIT 1").get(base.document_id))return 'CONFLICT';
 if(!drivePriority&&(!officeWriteAllowed(db,base.document_id,undefined,now)||officeOpeningBlocksExternalChange(db,base.document_id,now)))return 'OFFICE_ACTIVE';
 if(drivePriority){
  if(db.prepare("SELECT 1 FROM office_ingress WHERE document_id=? AND state='receiving' LIMIT 1").get(base.document_id)||db.prepare(`SELECT 1 FROM save_operations s WHERE s.document_id=? AND s.state='staged' AND s.cancelled_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM office_ingress i WHERE i.id=s.id AND i.document_id=s.document_id
    AND i.office_session_id=s.office_session_id AND i.author_id=s.author_id
    AND i.base_revision=s.base_revision AND i.base_digest=s.base_digest AND i.digest=s.digest AND i.size=s.size
    AND i.state IN ('prepared','failed') AND i.error_code IS NOT NULL) LIMIT 1`).get(base.document_id)||db.prepare("SELECT 1 FROM uploads WHERE state='active' AND json_extract(metadata,'$.documentId')=? AND expires_at>? LIMIT 1").get(base.document_id,now)||db.prepare("SELECT 1 FROM history_restores WHERE document_id=? AND state='staged' LIMIT 1").get(base.document_id))return 'SAVE_PENDING';
  return null;
 }
 if(db.prepare("SELECT 1 FROM office_ingress WHERE document_id=? AND (state='receiving' OR (state IN ('prepared','failed') AND digest IS NOT NULL)) LIMIT 1").get(base.document_id)||db.prepare("SELECT 1 FROM save_operations WHERE document_id=? AND state!='saved' AND cancelled_at IS NULL LIMIT 1").get(base.document_id)||db.prepare("SELECT 1 FROM uploads WHERE state='active' AND json_extract(metadata,'$.documentId')=? AND expires_at>? LIMIT 1").get(base.document_id,now)||db.prepare("SELECT 1 FROM history_restores WHERE document_id=? AND state='staged' LIMIT 1").get(base.document_id))return 'SAVE_PENDING';
 return null;
}
