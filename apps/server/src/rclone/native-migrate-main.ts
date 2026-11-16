/** Queue a non-destructive migration. Existing provider worker performs bounded batches. */
import {join} from 'node:path';
import {openDatabase,transaction} from '../database.ts';
const [workspace,selector]=process.argv.slice(2);
if(!workspace||!selector||process.env.YOURWIKI_NATIVE_MIGRATE!=='yes')throw Error('Usage: YOURWIKI_NATIVE_MIGRATE=yes node native-migrate-main.ts WORKSPACE DOCUMENT_ID|all');
const db=openDatabase(join(workspace,'database.sqlite3'));
try{
 await db.backup(join(workspace,'before-native-migration-'+Date.now()+'.sqlite3'));
 const queued=transaction(db,()=>{
  const rows=db.prepare(`SELECT b.document_id FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id JOIN rclone_drive_mounts m ON m.connection_id=c.id JOIN resources r ON r.id=b.document_id
   WHERE c.enabled=1 AND r.trashed=0 AND b.fingerprint LIKE '["rclone-drive-native-v1",%' AND (?='all' OR b.document_id=?)`).all(selector,selector) as {document_id:string}[];
  if(!rows.length&&selector!=='all')throw Error('No native document selected');
  for(const row of rows)db.prepare('INSERT INTO rclone_native_queue(document_id,requested_at) VALUES(?,?) ON CONFLICT(document_id) DO NOTHING').run(row.document_id,Date.now());
  return rows.length;
 });console.info(JSON.stringify({queued,mode:'background',originalsPreserved:true}));
}finally{db.close();}
