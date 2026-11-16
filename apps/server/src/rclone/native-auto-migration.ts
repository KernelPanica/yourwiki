import type {Database} from '../database.ts';

// Explicit opt-in: creating an Office copy changes which remote file YourWiki
// edits. The original remains intact. Called in the import transaction so a
// restart cannot leave an imported document without its queued migration.
export function queueImportedNativeMigration(db:Database,documentId:string,enabled:boolean) {
 if(!enabled)return false;
 return db.prepare(`INSERT INTO rclone_native_queue(document_id,requested_at)
  SELECT b.document_id,? FROM provider_source_bindings b
  JOIN provider_connections c ON c.id=b.connection_id
  JOIN resources r ON r.id=b.document_id
  JOIN rclone_drive_mounts m ON m.connection_id=c.id
  WHERE b.document_id=? AND c.enabled=1 AND r.trashed=0
   AND b.fingerprint LIKE '["rclone-drive-native-v1",%'
  ON CONFLICT(document_id) DO NOTHING`).run(Date.now(),documentId).changes>0;
}
