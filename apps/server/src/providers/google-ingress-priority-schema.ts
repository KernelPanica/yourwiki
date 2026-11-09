/** A definite failed outgoing write may be retired only after verified Drive
 * bytes became the accepted original. Uncertain dispatches are never eligible. */
export const googleIngressPriorityMigration=`
CREATE TABLE provider_ingress_supersessions (
 attempt_id TEXT PRIMARY KEY REFERENCES provider_delivery_attempts(id),
 snapshot_id TEXT NOT NULL REFERENCES provider_ingress_snapshots(id),created_at INTEGER NOT NULL
);
CREATE TRIGGER provider_ingress_supersession_proof BEFORE INSERT ON provider_ingress_supersessions BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM provider_delivery_attempts a JOIN provider_ingress_snapshots s ON s.id=NEW.snapshot_id
  JOIN provider_source_bindings b ON b.document_id=s.document_id JOIN provider_connections c ON c.id=b.connection_id
  WHERE a.id=NEW.attempt_id AND a.state IN ('conflict','retryable','blocked') AND s.state='applied'
   AND s.digest IS NOT NULL AND s.receipt IS NOT NULL AND a.document_id=s.document_id
   AND a.baseline=s.base_fingerprint AND a.base_revision=s.base_provider_revision
   AND a.binding_generation=s.binding_generation AND a.connection_revision=s.connection_revision
   AND b.connection_id=s.connection_id AND b.generation=s.binding_generation AND b.fingerprint=s.observed_fingerprint
   AND b.confirmed_revision=json_extract(s.receipt,'$.revision') AND c.enabled=1 AND c.provider='google' AND c.revision=s.connection_revision
 ) THEN RAISE(ABORT,'Ingress supersession requires an applied Drive snapshot') END;
END;
CREATE TRIGGER provider_ingress_supersession_immutable BEFORE UPDATE ON provider_ingress_supersessions BEGIN SELECT RAISE(ABORT,'Ingress supersession is immutable');END;
CREATE TRIGGER provider_ingress_supersession_retained BEFORE DELETE ON provider_ingress_supersessions BEGIN SELECT RAISE(ABORT,'Ingress supersession is retained');END;
DROP TRIGGER provider_attempt_transition;
CREATE TRIGGER provider_attempt_transition BEFORE UPDATE OF state ON provider_delivery_attempts WHEN NEW.state!=OLD.state AND NOT (
 (OLD.state='prepared' AND NEW.state IN ('writing','blocked','conflict')) OR
 (OLD.state='writing' AND NEW.state IN ('unknown','confirmed','retryable','conflict','blocked')) OR
 (OLD.state='unknown' AND NEW.state IN ('confirmed','retryable','conflict','blocked')) OR
 (OLD.state IN ('retryable','blocked') AND NEW.state='retired') OR
 (OLD.state='conflict' AND NEW.state='retired' AND (
  EXISTS(SELECT 1 FROM google_markdown_conflict_repairs p WHERE p.attempt_id=OLD.id) OR
  EXISTS(SELECT 1 FROM provider_ingress_supersessions p WHERE p.attempt_id=OLD.id)))
) BEGIN SELECT RAISE(ABORT,'Invalid provider attempt transition');END;
`;
