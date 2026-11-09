export const googleMarkdownRepairMigration=`
CREATE TABLE google_markdown_conflict_repairs (
 attempt_id TEXT PRIMARY KEY REFERENCES provider_delivery_attempts(id),
 observed_fingerprint TEXT NOT NULL,base_digest TEXT NOT NULL,size INTEGER NOT NULL,created_at INTEGER NOT NULL
);
CREATE TRIGGER google_markdown_repair_immutable BEFORE UPDATE ON google_markdown_conflict_repairs BEGIN SELECT RAISE(ABORT,'Repair proof is immutable');END;
CREATE TRIGGER google_markdown_repair_retained BEFORE DELETE ON google_markdown_conflict_repairs BEGIN SELECT RAISE(ABORT,'Repair proof is retained');END;
DROP TRIGGER provider_attempt_transition;
CREATE TRIGGER provider_attempt_transition BEFORE UPDATE OF state ON provider_delivery_attempts WHEN NEW.state!=OLD.state AND NOT (
 (OLD.state='prepared' AND NEW.state IN ('writing','blocked','conflict')) OR
 (OLD.state='writing' AND NEW.state IN ('unknown','confirmed','retryable','conflict','blocked')) OR
 (OLD.state='unknown' AND NEW.state IN ('confirmed','retryable','conflict','blocked')) OR
 (OLD.state IN ('retryable','blocked') AND NEW.state='retired') OR
 (OLD.state='conflict' AND NEW.state='retired' AND EXISTS(SELECT 1 FROM google_markdown_conflict_repairs p WHERE p.attempt_id=OLD.id))
) BEGIN SELECT RAISE(ABORT,'Invalid provider attempt transition');END;
`;
