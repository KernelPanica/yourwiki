import {join} from 'node:path';
import Sqlite from 'better-sqlite3';
import {assertRcloneMounted} from '../providers/rclone-mount-guard.ts';
const [workspace]=process.argv.slice(2);if(!workspace)throw Error('Workspace required');const db=new Sqlite(join(workspace,'database.sqlite3'),{readonly:true});try{const rows=db.prepare("SELECT m.mount_path FROM provider_connections c JOIN rclone_drive_mounts m ON m.connection_id=c.id WHERE c.provider='google' AND c.enabled=1").all() as {mount_path:string|null}[];for(const row of rows){if(!row.mount_path)throw Error('Authorized Drive mount is not ready');assertRcloneMounted(row.mount_path);}}finally{db.close();}
