import Sqlite from 'better-sqlite3';
import {migrations} from '../../src/schema.ts';
const db=new Sqlite(process.argv[2]!);db.pragma('foreign_keys=OFF');db.exec('BEGIN IMMEDIATE');const sql=migrations[22]!,stop=sql.indexOf('ALTER TABLE history_entries_rebuilt RENAME TO history_entries;');if(stop<0)throw new Error('No parent rebuild');db.exec(sql.slice(0,stop));console.log('parent-dropped-uncommitted');setInterval(()=>{},60000);
