/** Version 68: durable Google access revocation before recipient erasure. */
export const userPurgeMigration=`
CREATE TABLE user_google_purge_cleanup (
 user_id TEXT PRIMARY KEY REFERENCES users(id),recipient TEXT,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','blocked','complete')),
 error_code TEXT,created_at INTEGER NOT NULL,checked_at INTEGER NOT NULL DEFAULT 0,completed_at INTEGER
);
CREATE INDEX user_google_purge_recipient ON user_google_purge_cleanup(recipient) WHERE recipient IS NOT NULL;
DROP TRIGGER provider_google_grant_import_update;
CREATE TRIGGER provider_google_grant_import_update BEFORE UPDATE ON provider_google_grant_imports
WHEN NOT (
 NEW.recipient='' AND NEW.legacy_user_key IS NULL AND NEW.permission_id='' AND NEW.desired_role='' AND NEW.applied_role='' AND NEW.status='revoked' AND NEW.attempted_at IS NULL
 AND NEW.legacy_key IS OLD.legacy_key AND NEW.connection_legacy_key IS OLD.connection_legacy_key AND NEW.connection_id IS OLD.connection_id
 AND NEW.reference IS OLD.reference AND NEW.object_key IS OLD.object_key AND NEW.source_fingerprint IS OLD.source_fingerprint AND NEW.created_at IS OLD.created_at
 AND EXISTS(SELECT 1 FROM user_google_purge_cleanup p WHERE p.state='complete' AND p.recipient=lower(OLD.recipient))
 AND NOT EXISTS(SELECT 1 FROM provider_google_grants g WHERE g.recipient=lower(OLD.recipient) AND (g.state!='synced' OR g.applied_role!='' OR g.permission_id IS NOT NULL OR g.pending_action IS NOT NULL))
) BEGIN SELECT RAISE(ABORT,'Google grant import is immutable'); END;
INSERT INTO user_google_purge_cleanup(user_id,recipient,created_at)
 SELECT u.id,lower(i.email),u.purged_at FROM users u JOIN provider_google_identities i ON i.user_id=u.id
 WHERE u.purged_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM provider_google_identities other JOIN users a ON a.id=other.user_id WHERE other.user_id!=u.id AND other.active=1 AND a.active=1 AND a.purged_at IS NULL AND lower(other.email)=lower(i.email));
UPDATE provider_google_grants SET desired_role='',state=CASE WHEN state='unknown' THEN state ELSE 'pending' END,checked_at=0 WHERE recipient IN(SELECT recipient FROM user_google_purge_cleanup);
DELETE FROM provider_google_identities WHERE user_id IN(SELECT id FROM users WHERE purged_at IS NOT NULL);
DELETE FROM sessions WHERE user_id IN(SELECT id FROM users WHERE purged_at IS NOT NULL);
DELETE FROM office_tokens WHERE user_id IN(SELECT id FROM users WHERE purged_at IS NOT NULL);
DELETE FROM provider_google_identity_states WHERE user_id IN(SELECT id FROM users WHERE purged_at IS NOT NULL);
DELETE FROM provider_google_original_sessions WHERE user_id IN(SELECT id FROM users WHERE purged_at IS NOT NULL);
DELETE FROM provider_google_connect_states WHERE user_id IN(SELECT id FROM users WHERE purged_at IS NOT NULL);
DELETE FROM google_registration_attempts WHERE user_id IN(SELECT id FROM users WHERE purged_at IS NOT NULL);
DELETE FROM password_reset_links WHERE user_id IN(SELECT id FROM users WHERE purged_at IS NOT NULL) OR creator_id IN(SELECT id FROM users WHERE purged_at IS NOT NULL);
DELETE FROM memberships WHERE user_id IN(SELECT id FROM users WHERE purged_at IS NOT NULL);
DELETE FROM user_invite_groups WHERE user_id IN(SELECT id FROM users WHERE purged_at IS NOT NULL);
DELETE FROM user_preferences WHERE user_id IN(SELECT id FROM users WHERE purged_at IS NOT NULL);
DELETE FROM document_presence WHERE user_id IN(SELECT id FROM users WHERE purged_at IS NOT NULL);
DELETE FROM document_visits WHERE user_id IN(SELECT id FROM users WHERE purged_at IS NOT NULL);
UPDATE invitations SET revoked=1 WHERE creator_id IN(SELECT id FROM users WHERE purged_at IS NOT NULL);
UPDATE resources SET user_policies=COALESCE((SELECT json_group_object(j.key,json(CASE WHEN j.type IN ('object','array') THEN j.value WHEN j.type='true' THEN 'true' WHEN j.type='false' THEN 'false' ELSE json_quote(j.value) END)) FROM json_each(resources.user_policies) j WHERE NOT EXISTS(SELECT 1 FROM users u WHERE u.id=j.key AND u.purged_at IS NOT NULL)),'{}') WHERE EXISTS(SELECT 1 FROM json_each(resources.user_policies) j JOIN users u ON u.id=j.key WHERE u.purged_at IS NOT NULL);
UPDATE local_trash SET details='{}',name='Deleted user' WHERE kind='user' AND object_id IN(SELECT id FROM users WHERE purged_at IS NOT NULL);
UPDATE app_state SET acl_epoch=acl_epoch+1 WHERE id=1;
`;
