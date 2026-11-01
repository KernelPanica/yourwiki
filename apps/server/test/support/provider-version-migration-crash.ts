/** Owned version30 fixture only: hold a parent rebuild before committing. */
import Sqlite from 'better-sqlite3';
import {migrations} from '../../src/schema.ts';
const db=new Sqlite(process.argv[2]!);db.pragma('foreign_keys=OFF');db.exec('BEGIN IMMEDIATE');const sql=migrations[30]!,stop=sql.indexOf('ALTER TABLE document_versions_rebuilt RENAME TO document_versions;');if(stop<0)throw new Error('Missing source rebuild boundary');db.exec(sql.slice(0,stop));console.log('source-dropped-uncommitted');setInterval(()=>{},60000);
