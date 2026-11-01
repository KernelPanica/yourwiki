import type {Statement} from 'better-sqlite3';
import {transaction,readTransaction,type Database} from './database.ts';
import {validateLegacyHistoryMetadata} from './history-archive.ts';
import {DocumentError} from './document-errors.ts';
/** Internal storage identities never belong in public history DTOs or URLs. */
export type HistoryCatalogueRecord={storageId:number;publicId:number;document_id:string;kind:'source'|'pdf-layer';source_revision:number;layer_revision:number|null;digest:string;size:number;title:string;format:string;captured_by:string|null;captured_by_name:string;created_at:number;legacy_metadata:string|null};
type Stored=Omit<HistoryCatalogueRecord,'storageId'|'publicId'>&{id:number;public_id:number|null;import_id:string|null;import_ordinal:number|null};
type Range={id:string;document_id:string;first_public_id:number;last_public_id:number;entry_count:number;catalogue_ready:number};
type Key={storageId:number;publicId:number};
const safe=(value:unknown,minimum=1):value is number=>Number.isSafeInteger(value)&&Number(value)>=minimum;
function corrupt():never{throw new DocumentError('HISTORY_CORRUPT');}
function input(documentId:string,value?:number){if(typeof documentId!=='string'||!documentId||documentId.length>128||value!==undefined&&!safe(value))throw new DocumentError('INVALID_REQUEST');}
function range(value:Range){if(!safe(value.first_public_id)||!safe(value.last_public_id,value.first_public_id)||!safe(value.entry_count)||value.entry_count>100000||value.last_public_id-value.first_public_id+1!==value.entry_count||value.catalogue_ready!==1)corrupt();return value;}
/** Read-only, bounded visibility catalogue. Callers still perform current document authorization. */
export class HistoryCatalogue{
 private db:Database;private mutations=new Map<string,Statement<unknown[]>>();
 private local;private roots;private matching;private imported;private stored;private owner;private localAscending;private rootsAscending;private importedAscending;
 constructor(db:Database){this.db=db;
  this.local=db.prepare('SELECT id AS storageId,public_id AS publicId FROM history_entries WHERE document_id=? AND import_id IS NULL AND public_id<=? ORDER BY public_id DESC LIMIT ?');
  this.roots=db.prepare("SELECT id,document_id,first_public_id,last_public_id,entry_count,catalogue_ready FROM history_imports WHERE document_id=? AND state='committed' AND first_public_id IS NOT NULL AND first_public_id<=? ORDER BY first_public_id DESC LIMIT ?");
  this.matching=db.prepare("SELECT id,document_id,first_public_id,last_public_id,entry_count,catalogue_ready FROM history_imports WHERE document_id=? AND state='committed' AND first_public_id IS NOT NULL AND first_public_id<=? ORDER BY first_public_id DESC LIMIT 1");
  this.imported=db.prepare('SELECT id AS storageId,import_ordinal AS ordinal FROM history_entries WHERE import_id=? AND import_ordinal<=? ORDER BY import_ordinal DESC LIMIT ?');
  this.localAscending=db.prepare('SELECT id AS storageId,public_id AS publicId FROM history_entries WHERE document_id=? AND import_id IS NULL AND public_id>? AND public_id<=? ORDER BY public_id LIMIT ?');
  this.rootsAscending=db.prepare("SELECT id,document_id,first_public_id,last_public_id,entry_count,catalogue_ready FROM history_imports WHERE document_id=? AND state='committed' AND first_public_id IS NOT NULL AND first_public_id>? AND first_public_id<=? ORDER BY first_public_id LIMIT ?");
  this.importedAscending=db.prepare('SELECT id AS storageId,import_ordinal AS ordinal FROM history_entries WHERE import_id=? AND import_ordinal>? AND import_ordinal<=? ORDER BY import_ordinal LIMIT ?');
  this.owner=db.prepare('SELECT id,document_id,state,first_public_id,last_public_id,entry_count,catalogue_ready FROM history_imports WHERE id=?');
  this.stored=db.prepare('SELECT e.*,(SELECT metadata_json FROM history_legacy_metadata WHERE entry_id=e.id) AS legacy_metadata FROM history_entries e WHERE e.document_id=? AND e.id=?');
 }
 private record(documentId:string,key:Key){if(!safe(key.storageId)||!safe(key.publicId))corrupt();const row=this.stored.get(documentId,key.storageId) as Stored|undefined;if(!row)corrupt();const {id,public_id,import_id,import_ordinal,...snapshot}=row;return {storageId:id,publicId:key.publicId,...snapshot} satisfies HistoryCatalogueRecord;}
 lookup(documentId:string,publicId:number):HistoryCatalogueRecord|undefined{input(documentId,publicId);return readTransaction(this.db,()=>{
  const local=this.local.all(documentId,publicId,1) as Key[];if(local[0]?.publicId===publicId)return this.record(documentId,local[0]);const roots=this.matching.all(documentId,publicId) as Range[];if(!roots.length)return undefined;const root=range(roots[0]);if(publicId>root.last_public_id)return undefined;const ordinal=publicId-root.first_public_id,keys=this.imported.all(root.id,ordinal,1) as {storageId:number;ordinal:number}[];if(keys[0]?.ordinal!==ordinal)corrupt();return this.record(documentId,{storageId:keys[0].storageId,publicId});
 });}
 byStorageId(documentId:string,storageId:number):HistoryCatalogueRecord|undefined{input(documentId,storageId);return readTransaction(this.db,()=>{
  const row=this.stored.get(documentId,storageId) as Stored|undefined;if(!row)return undefined;if(row.import_id===null){if(!safe(row.public_id))corrupt();return this.record(documentId,{storageId,publicId:row.public_id});}
  const root=this.owner.get(row.import_id) as (Range&{state:string})|undefined;
  if(!root||root.document_id!==documentId)corrupt();if(root.state!=='committed')return undefined;range(root);if(!safe(row.import_ordinal,0)||row.import_ordinal>=root.entry_count)corrupt();return this.record(documentId,{storageId,publicId:root.first_public_id+row.import_ordinal});
 });}
 publicId(documentId:string,storageId:number){return this.byStorageId(documentId,storageId)?.publicId;}
 snapshot(documentId:string):{count:number;high:number}{input(documentId);return readTransaction(this.db,()=>{const usage=this.db.prepare('SELECT entry_count FROM history_usage WHERE document_id=?').get(documentId) as {entry_count:number}|undefined,sequence=this.db.prepare('SELECT value FROM history_public_sequence WHERE singleton=1').get() as {value:number}|undefined;const count=usage?.entry_count??0,high=sequence?.value;if(!safe(count,0)||count>100000||!safe(high,0)||count>0&&high===0)corrupt();return {count,high};});}
 ascending(documentId:string,options:{after:number;high:number;limit?:number}):number[]{input(documentId);const {after,high}=options,limit=options.limit??50;if(!safe(after,0)||!safe(high,0)||after>high||!safe(limit)||limit>200)throw new DocumentError('INVALID_REQUEST');return readTransaction(this.db,()=>{
  const keys=this.localAscending.all(documentId,after,high,limit) as Key[],roots=this.rootsAscending.all(documentId,after,high,limit) as Range[],previous=(this.matching.all(documentId,after) as Range[])[0];if(previous&&range(previous).last_public_id>after)roots.unshift(previous);
  for(const value of roots){const root=range(value),low=Math.max(-1,after-root.first_public_id),top=Math.min(high,root.last_public_id)-root.first_public_id;if(top<=low)continue;const found=this.importedAscending.all(root.id,low,top,limit) as {storageId:number;ordinal:number}[];if(found.length!==Math.min(limit,top-low))corrupt();for(let i=0;i<found.length;i++){if(found[i].ordinal!==low+1+i)corrupt();keys.push({storageId:found[i].storageId,publicId:root.first_public_id+found[i].ordinal});}}
  keys.sort((a,b)=>a.publicId-b.publicId);for(let i=0;i<keys.length;i++)if(!safe(keys[i].publicId)||!safe(keys[i].storageId)||i&&keys[i-1].publicId===keys[i].publicId)corrupt();return keys.slice(0,limit).map(key=>key.publicId);
 });}
 page(documentId:string,options:{after?:number;limit?:number}={}):{items:HistoryCatalogueRecord[];nextCursor:string|null}{input(documentId,options.after);const limit=options.limit??50;if(!safe(limit)||limit>200)throw new DocumentError('INVALID_REQUEST');return readTransaction(this.db,()=>{
  const maximum=options.after===undefined?Number.MAX_SAFE_INTEGER:options.after-1,take=limit+1,keys=this.local.all(documentId,maximum,take) as Key[];
  for(const candidate of this.roots.all(documentId,maximum,take) as Range[]){const root=range(candidate),highest=Math.min(maximum,root.last_public_id)-root.first_public_id,imported=this.imported.all(root.id,highest,take) as {storageId:number;ordinal:number}[];if(imported.length!==Math.min(take,highest+1))corrupt();for(let index=0;index<imported.length;index++){const key=imported[index];if(key.ordinal!==highest-index)corrupt();keys.push({storageId:key.storageId,publicId:root.first_public_id+key.ordinal});}}
  keys.sort((a,b)=>b.publicId-a.publicId);for(let index=0;index<keys.length;index++){if(!safe(keys[index].publicId)||!safe(keys[index].storageId)||index&&keys[index-1].publicId===keys[index].publicId)corrupt();}
  const items=keys.slice(0,limit).map(key=>this.record(documentId,key));return {items,nextCursor:keys.length>limit?String(items.at(-1)!.publicId):null};
 });}
 private mutation(sql:string){let statement=this.mutations.get(sql);if(!statement){statement=this.db.prepare(sql);this.mutations.set(sql,statement);}return statement;}
 /** Caller holds the import lease and a bounded transaction; no blobs are adopted here. */
 stageImportEntry(value:{importId:string;generation:number;ordinal:number;metadata:string;blob:{digest:string;size:number}}){return transaction(this.db,()=>{
  const root=this.mutation('SELECT document_id,generation,state,catalogue_ready FROM history_imports WHERE id=?').get(value.importId) as {document_id:string;generation:number;state:string;catalogue_ready:number}|undefined;
  if(!root||root.generation!==value.generation||root.catalogue_ready||!['receiving','prepared'].includes(root.state))throw new DocumentError('HISTORY_IMPORT_LEASE_LOST');
  const meta=validateLegacyHistoryMetadata(JSON.parse(value.metadata),65536);if(meta.sha256!==value.blob.digest||!safe(value.blob.size,0))throw new DocumentError('HISTORY_ARCHIVE_CORRUPT');
  const staged=this.mutation('SELECT digest,size,entry_id FROM history_import_entries WHERE import_id=? AND ordinal=?').get(value.importId,value.ordinal) as {digest:string;size:number;entry_id:number|null}|undefined;
  if(staged){if(staged.digest!==value.blob.digest||staged.size!==value.blob.size||staged.entry_id!==null)throw new DocumentError('HISTORY_ARCHIVE_CORRUPT');}
  else this.mutation('INSERT INTO history_import_entries(import_id,ordinal,digest,size) VALUES(?,?,?,?)').run(value.importId,value.ordinal,value.blob.digest,value.blob.size);
  const id=Number(this.mutation("INSERT INTO history_entries(document_id,kind,source_revision,digest,size,title,format,captured_by_name,created_at,import_id,import_ordinal) VALUES(?,'source',?,?,?,?,?,?,?,?,?)").run(root.document_id,meta.revision,value.blob.digest,value.blob.size,meta.title,meta.file_format,meta.author?.name??'',Date.parse(meta.saved_at),value.importId,value.ordinal).lastInsertRowid);
  this.mutation('INSERT INTO history_legacy_metadata(entry_id,metadata_json) VALUES(?,?)').run(id,value.metadata);this.mutation('UPDATE history_import_entries SET metadata_json=NULL WHERE import_id=? AND ordinal=?').run(value.importId,value.ordinal);return id;
 });}
 /** Constant-work final publication; preparation has already sealed every canonical row. */
 publishImport(value:{importId:string;generation:number;token:string;now:number}){return transaction(this.db,()=>{
  const root=this.mutation("SELECT * FROM history_imports WHERE id=? AND generation=? AND lease_token=? AND lease_until>? AND state='prepared' AND catalogue_ready=1 AND adoption_started=1").get(value.importId,value.generation,value.token,value.now) as {entry_count:number;total_bytes:number;archive_digest:string;archive_size:number}|undefined;if(!root)throw new DocumentError('HISTORY_IMPORT_LEASE_LOST');
  const high=(this.mutation('SELECT value FROM history_public_sequence WHERE singleton=1').get() as {value:number}).value,last=high+root.entry_count;if(!safe(last,0))throw new DocumentError('HISTORY_LIMIT');
  const receipt={entries:root.entry_count,totalBytes:root.total_bytes,firstEntryId:root.entry_count?high+1:null,lastEntryId:root.entry_count?last:null,archiveSha256:root.archive_digest,archiveSize:root.archive_size};
  this.mutation('UPDATE history_public_sequence SET value=? WHERE singleton=1').run(last);
  this.mutation("UPDATE history_imports SET state='committed',first_public_id=?,last_public_id=?,receipt=?,error_code=NULL,lease_token=NULL,lease_until=0,updated_at=? WHERE id=?").run(receipt.firstEntryId,receipt.lastEntryId,JSON.stringify(receipt),value.now,value.importId);return receipt;
 });}
 /** Private failed rows only, bounded by rows AND metadata bytes; caller yields between pages. */
 deleteFailedPage(value:{importId:string;generation:number;token:string;now:number;maxRows:50;maxMetadataBytes:1048576}){return transaction(this.db,()=>{
  const root=this.mutation("SELECT catalogue_ready,adoption_started FROM history_imports WHERE id=? AND generation=? AND lease_token=? AND lease_until>? AND state='failed'").get(value.importId,value.generation,value.token,value.now) as {catalogue_ready:number;adoption_started:number}|undefined;if(!root||root.adoption_started)throw new DocumentError('HISTORY_IMPORT_LEASE_LOST');
  if(root.catalogue_ready)this.mutation('UPDATE history_imports SET catalogue_ready=0 WHERE id=?').run(value.importId);
  const rows=this.mutation('SELECT s.ordinal,s.entry_id,COALESCE(length(CAST(m.metadata_json AS BLOB)),length(CAST(s.metadata_json AS BLOB)),0) AS bytes FROM history_import_entries s LEFT JOIN history_legacy_metadata m ON m.entry_id=s.entry_id WHERE s.import_id=? ORDER BY s.ordinal LIMIT ?').all(value.importId,value.maxRows) as {ordinal:number;entry_id:number|null;bytes:number}[];
  let removed=0,total=0;for(const row of rows){if(total+row.bytes>value.maxMetadataBytes)break;total+=row.bytes;this.mutation('DELETE FROM history_import_entries WHERE import_id=? AND ordinal=?').run(value.importId,row.ordinal);if(row.entry_id!==null)this.mutation('DELETE FROM history_entries WHERE id=? AND import_id=?').run(row.entry_id,value.importId);removed++;}
  return {removed,done:!this.mutation('SELECT 1 FROM history_import_entries WHERE import_id=? LIMIT 1').get(value.importId)};
 });}

}
