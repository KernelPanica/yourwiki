import {readTransaction,type Database} from './database.ts';
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
 private db:Database;
 private local;private roots;private matching;private imported;private stored;private owner;
 constructor(db:Database){this.db=db;
  this.local=db.prepare('SELECT id AS storageId,public_id AS publicId FROM history_entries WHERE document_id=? AND import_id IS NULL AND public_id<=? ORDER BY public_id DESC LIMIT ?');
  this.roots=db.prepare("SELECT id,document_id,first_public_id,last_public_id,entry_count,catalogue_ready FROM history_imports WHERE document_id=? AND state='committed' AND first_public_id IS NOT NULL AND first_public_id<=? ORDER BY first_public_id DESC LIMIT ?");
  this.matching=db.prepare("SELECT id,document_id,first_public_id,last_public_id,entry_count,catalogue_ready FROM history_imports WHERE document_id=? AND state='committed' AND first_public_id IS NOT NULL AND first_public_id<=? ORDER BY first_public_id DESC LIMIT 1");
  this.imported=db.prepare('SELECT id AS storageId,import_ordinal AS ordinal FROM history_entries WHERE import_id=? AND import_ordinal<=? ORDER BY import_ordinal DESC LIMIT ?');
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
 page(documentId:string,options:{after?:number;limit?:number}={}):{items:HistoryCatalogueRecord[];nextCursor:string|null}{input(documentId,options.after);const limit=options.limit??50;if(!safe(limit)||limit>200)throw new DocumentError('INVALID_REQUEST');return readTransaction(this.db,()=>{
  const maximum=options.after===undefined?Number.MAX_SAFE_INTEGER:options.after-1,take=limit+1,keys=this.local.all(documentId,maximum,take) as Key[];
  for(const candidate of this.roots.all(documentId,maximum,take) as Range[]){const root=range(candidate),highest=Math.min(maximum,root.last_public_id)-root.first_public_id,imported=this.imported.all(root.id,highest,take) as {storageId:number;ordinal:number}[];if(imported.length!==Math.min(take,highest+1))corrupt();for(let index=0;index<imported.length;index++){const key=imported[index];if(key.ordinal!==highest-index)corrupt();keys.push({storageId:key.storageId,publicId:root.first_public_id+key.ordinal});}}
  keys.sort((a,b)=>b.publicId-a.publicId);for(let index=0;index<keys.length;index++){if(!safe(keys[index].publicId)||!safe(keys[index].storageId)||index&&keys[index-1].publicId===keys[index].publicId)corrupt();}
  const items=keys.slice(0,limit).map(key=>this.record(documentId,key));return {items,nextCursor:keys.length>limit?String(items.at(-1)!.publicId):null};
 });}
}
