/** Explicit offline metadata cutover. Never deletes or moves remote objects. */
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {openDatabase,transaction} from '../database.ts';
import {RcloneClient,rcloneFingerprint} from './client.ts';
import {RcloneDriveAdapter} from './adapter.ts';
import {mountRuntime} from './storage-worker.ts';
const [workspace]=process.argv.slice(2);if(process.env.YOURWIKI_RCLONE_MIGRATE!=='yes'||!workspace)throw Error('Explicit offline migration required');const db=openDatabase(join(workspace,'database.sqlite3'));
try{let checked=0,unchanged=0,external=0;const updates:{id:string;old:string;next:string}[]=[];
 const mounts=db.prepare("SELECT m.* FROM rclone_drive_mounts m JOIN provider_connections c ON c.id=m.connection_id WHERE c.enabled=1").all() as any[];if(!mounts.length)throw Error('No ready Drive mounts');
 for(const mount of mounts){const client=new RcloneClient(mountRuntime(mount)),scope={check(){if(db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND lease_until>?").get(Date.now()))throw Error('Source worker must be stopped');}},entries=await client.list(scope);transaction(db,()=>{db.prepare('DELETE FROM rclone_drive_entries WHERE connection_id=?').run(mount.connection_id);for(const e of entries)db.prepare('INSERT INTO rclone_drive_entries VALUES(?,?,?,?,?)').run(mount.connection_id,e.ID,e.Path,JSON.stringify(e),Date.now());});const map=new Map(entries.map(e=>[e.ID,e]));
 const rows=db.prepare('SELECT b.document_id,b.reference,b.fingerprint,d.local_revision,d.provider_revision,v.digest,v.size FROM provider_source_bindings b JOIN resources r ON r.id=b.document_id JOIN documents d ON d.id=b.document_id JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision WHERE b.connection_id=? AND r.trashed=0').all(mount.connection_id) as any[];
 for(const row of rows){const e=map.get(row.reference);if(!e||e.IsDir)throw Error('Active source not found in rclone inventory');if(row.local_revision!==row.provider_revision)throw Error('Unsent local changes require reconciliation before migration');const reader=new RcloneDriveAdapter({runtime:mountRuntime(mount),reference:e.ID,path:e.Path,check:scope.check});try{const read=await reader.read(e.ID,scope),hash=createHash('sha256');let size=0;for await(const chunk of read.bytes){hash.update(chunk);size+=chunk.byteLength;}checked++;if(hash.digest('hex')===row.digest&&size===row.size){updates.push({id:row.document_id,old:row.fingerprint,next:rcloneFingerprint(e)});unchanged++;}else external++;}finally{await reader.close();}}
 }
 transaction(db,()=>{for(const u of updates){if(db.prepare('UPDATE provider_source_bindings SET fingerprint=? WHERE document_id=? AND fingerprint=?').run(u.next,u.id,u.old).changes!==1)throw Error('Source changed during migration');}db.prepare('UPDATE provider_sync_checks SET due_at=0 WHERE document_id IN(SELECT b.document_id FROM provider_source_bindings b JOIN rclone_drive_mounts m ON m.connection_id=b.connection_id)').run();});
 if((db.pragma('foreign_key_check') as unknown[]).length)throw Error('Foreign key check failed');console.info(JSON.stringify({rcloneMigration:'verified',mounts:mounts.length,checked,unchanged,externalChangesQueued:external}));
}finally{db.close();}
