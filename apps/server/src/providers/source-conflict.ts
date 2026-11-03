import type {Database} from '../database.ts';
/** Durable evidence of verified incoming bytes for the current baseline, not a failed probe.
 * Cached metadata only: no credentials/provider IO, permission changes or implicit resolution.
 * Discarding a private copy does not resolve the original; accepted-baseline changes do.
 * Older connection/binding/baseline receipts cannot fence a newly accepted original. */
export function hasIncomingSourceConflict(db:Database,documentId:string):boolean{
 return !!db.prepare(`SELECT 1 FROM provider_source_bindings b
  JOIN provider_connections c ON c.id=b.connection_id AND c.enabled=1
  JOIN provider_ingress_snapshots s ON s.document_id=b.document_id AND s.connection_id=b.connection_id
   AND s.connection_revision=c.revision AND s.binding_generation=b.generation AND s.base_fingerprint=b.fingerprint
  WHERE b.document_id=? AND s.state IN ('staged','conflict','discarding','discarded') AND s.digest IS NOT NULL
   AND s.observed_fingerprint!=b.fingerprint LIMIT 1`).get(documentId);
}
