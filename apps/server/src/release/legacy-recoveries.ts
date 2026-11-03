import type Sqlite from 'better-sqlite3';
import type {Database} from '../database.ts';
import type {BlobStore} from '../storage/blobs.ts';
const canonical=(id:unknown)=>String(id).replace(/^([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/i,'$1-$2-$3-$4-$5');
const stamp=(v:unknown)=>{if(typeof v==='number')return v;const n=Date.parse(String(v));return Number.isFinite(n)?n:Date.now();};
/** Stopped-source import: no old token/lock/job can execute in the new runtime.
 * Pending content is copied with bounded SQLite substr reads, never silently replayed.
 */
export async function importLegacyRecoveries(source:Sqlite.Database,target:Database,store:BlobStore){
 const handled=new Set<string>(),blockers:string[]=[],counts:Record<string,number>={};
 const columns=(table:string)=>new Set((source.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(c=>c.name));
 for(const spec of [
  {table:'wiki_collaboration',key:'document_id',payloads:['state','snapshot'],required:['sequence','synced_sequence','updated_at'],author:null},
  {table:'wiki_savesession',key:'id',payloads:['payload'],required:['state','base_revision','updated_at'],author:'author_id'},
  {table:'wiki_officesession',key:'id',payloads:['pending'],required:['superseded','expires_at'],author:'pending_author_id'},
 ] as const){const fields=columns(spec.table);if(!fields.size)continue;if(!['document_id',spec.key,...spec.required,...spec.payloads].every(k=>fields.has(k)))continue;
  const scalar=[...new Set([spec.key,'document_id',...spec.required,...(spec.author&&fields.has(spec.author)?[spec.author]:[])])];
  for(const row of source.prepare(`SELECT ${scalar.join(',')} FROM ${spec.table}`).iterate() as Iterable<Record<string,any>>){const documentId=canonical(row.document_id),doc=target.prepare('SELECT 1 FROM documents WHERE id=?').get(documentId);if(!doc){blockers.push('RECOVERY_DOCUMENT_MISSING:'+documentId);continue;}let author=spec.author?row[spec.author]:null;if(author!=null&&!target.prepare('SELECT 1 FROM users WHERE id=?').get(String(author)))author=null;
   for(const payload of spec.payloads){const size=(source.prepare(`SELECT length(CAST(${payload} AS BLOB)) n FROM ${spec.table} WHERE ${spec.key}=?`).get(row[spec.key]) as {n:number|null}).n??0;if(!size)continue;if(size>4*1024**3)throw new Error('LEGACY_RECOVERY_TOO_LARGE');
    async function* chunks(){let offset=1;const query=source.prepare(`SELECT substr(CAST(${payload} AS BLOB),?,?) bytes FROM ${spec.table} WHERE ${spec.key}=?`);while(offset<=size){const result=query.get(offset,Math.min(1024*1024,size-offset+1),row[spec.key]) as {bytes:Buffer};if(!result.bytes?.length)throw new Error('LEGACY_RECOVERY_TRUNCATED');offset+=result.bytes.length;yield result.bytes;}}
    const ref=await store.put(chunks(),{maxBytes:4*1024**3});if(ref.size!==size)throw new Error('LEGACY_RECOVERY_TRUNCATED');const id=`legacy:${spec.table}:${row[spec.key]}:${payload}`,reason=spec.table==='wiki_collaboration'?(payload==='state'?'LEGACY_CRDT_STATE':'LEGACY_SHARED_SNAPSHOT'):spec.table==='wiki_officesession'?'LEGACY_OFFICE_PENDING':'LEGACY_SAVE_'+String(row.state).toUpperCase();target.prepare('INSERT INTO recovery_copies(id,document_id,intended_document_id,author_id,digest,size,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,documentId,documentId,author==null?null:String(author),ref.digest,ref.size,reason,stamp(row.updated_at??row.expires_at));
   }
   if(spec.table==='wiki_savesession'&&['pending','unknown'].includes(row.state))blockers.push('UNRESOLVED_PROVIDER_SAVE:'+documentId);counts[spec.table]=(counts[spec.table]??0)+1;
  }handled.add(spec.table);
 }
 // Browser presence and source leases are ephemeral. Their exact original rows remain
 // in the immutable source archive; copied capabilities must never become usable.
 for(const table of ['wiki_presencesession','wiki_sourcelease','django_session']){if(columns(table).size){handled.add(table);counts[table]=(source.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as {n:number}).n;}}
 return {handled,blockers,counts};
}
