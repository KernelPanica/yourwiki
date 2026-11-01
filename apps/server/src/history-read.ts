import {validateLegacyHistoryMetadata,type LegacyHistoryMetadata} from './history-archive.ts';
import type {Readable} from 'node:stream';
import {readTransaction,type Database} from './database.ts';
import {DocumentError} from './document-errors.ts';
import {DocumentService} from './documents.ts';
import {AccessService} from './access.ts';
import {historyPolicy} from './history-settings.ts';
import {HistoryCatalogue,type HistoryCatalogueRecord} from './history-catalogue.ts';
import {HistoryIntegrity} from './history-integrity.ts';
import type {BlobStore,ByteRange} from './storage/blobs.ts';
type Row=HistoryCatalogueRecord;
export type HistoryEntry={id:number;documentId:string;kind:'source'|'pdf-layer';sourceRevision:number;layerRevision:number|null;sha256:string;size:number;title:string;format:string;author:{id:string|null;name:string};capturedAt:number;legacy?:{revision:number;kind:string;fileFormat:string;savedAt:string;author:null|{id:string|number;name:string}}};
function entryId(value:number){if(!Number.isSafeInteger(value)||value<1)throw new DocumentError('INVALID_REQUEST');}
function metadata(row:Row):HistoryEntry{
 let legacy:LegacyHistoryMetadata|undefined;
 if(row.legacy_metadata!==null&&row.legacy_metadata!==undefined){try{legacy=validateLegacyHistoryMetadata(JSON.parse(row.legacy_metadata),65536);}catch{throw new DocumentError('HISTORY_CORRUPT');}
  if(row.kind!=='source'||legacy.revision!==row.source_revision||legacy.sha256!==row.digest||legacy.file_format!==row.format||legacy.title!==row.title||Date.parse(legacy.saved_at)!==row.created_at||(legacy.author?.name??'')!==row.captured_by_name)throw new DocumentError('HISTORY_CORRUPT');
 }

 if(!/^[a-f0-9]{64}$/.test(row.digest)||!Number.isSafeInteger(row.size)||row.size<0||!Number.isSafeInteger(row.publicId)||row.publicId<1||!Number.isSafeInteger(row.source_revision)||row.source_revision<(legacy?0:1)||!['source','pdf-layer'].includes(row.kind)||(row.kind==='source'?row.layer_revision!==null:!Number.isSafeInteger(row.layer_revision)||row.layer_revision!<0)||typeof row.title!=='string'||row.title.length>2000||typeof row.format!=='string'||!(legacy&&row.format===''||/^[a-z0-9][a-z0-9.-]{0,31}$/.test(row.format))||typeof row.captured_by_name!=='string'||row.captured_by_name.length>2000||!Number.isSafeInteger(row.created_at)||Math.abs(row.created_at)>8640000000000000)throw new DocumentError('HISTORY_CORRUPT');
 return {id:row.publicId,documentId:row.document_id,kind:row.kind,sourceRevision:row.source_revision,layerRevision:row.layer_revision,sha256:row.digest,size:row.size,title:row.title,format:row.format,author:{id:row.captured_by,name:row.captured_by_name},capturedAt:row.created_at,...(legacy?{legacy:{revision:legacy.revision,kind:legacy.kind,fileFormat:legacy.file_format,savedAt:legacy.saved_at,author:legacy.author?{id:legacy.author.id,name:legacy.author.name}:null}}:{})};
}
/** History authority is the document plus immutable receipt; a digest alone grants no access. */
export class HistoryRead{
 private db:Database;private store:BlobStore;private docs:DocumentService;private access:AccessService;private integrity:HistoryIntegrity;private catalogue:HistoryCatalogue;private lifetime=new AbortController();
 constructor(db:Database,store:BlobStore){this.db=db;this.store=store;this.docs=new DocumentService(db,store);this.access=new AccessService(db);this.integrity=new HistoryIntegrity(db);this.catalogue=new HistoryCatalogue(db);}
 private context(userId:string,documentId:string){
  this.lifetime.signal.throwIfAborted();const doc=this.docs.getPublished(userId,documentId);if(!doc)throw new DocumentError('NOT_FOUND');const policy=historyPolicy(this.db);return {schemaVersion:2 as const,enabled:policy.enabled===1,settingsRevision:policy.revision,document:{id:doc.id,localRevision:doc.localRevision,publishedRevision:doc.revision,write:this.access.allows(userId,documentId,'write'),export:this.access.allows(userId,documentId,'export')}};
 }
 private record(documentId:string,id:number){entryId(id);const row=this.catalogue.lookup(documentId,id);if(!row)throw new DocumentError('NOT_FOUND');return row;}
 private row(documentId:string,id:number){return metadata(this.record(documentId,id));}
 list(userId:string,documentId:string,options:{after?:string;limit?:number}={}){
  const limit=options.limit??50;if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw new DocumentError('INVALID_REQUEST');let after:number|undefined;
  if(options.after!==undefined){if(typeof options.after!=='string'||!/^[1-9][0-9]{0,15}$/.test(options.after))throw new DocumentError('INVALID_REQUEST');after=Number(options.after);entryId(after);}
  return readTransaction(this.db,()=>{const context=this.context(userId,documentId),page=this.catalogue.page(documentId,{after,limit});return {...context,items:page.items.map(metadata),nextCursor:page.nextCursor};});
 }
 entry(userId:string,documentId:string,id:number){return readTransaction(this.db,()=>({...this.context(userId,documentId),item:this.row(documentId,id)}));}
 /** Internal reference only; never return this object from an HTTP metadata handler. */
 reference(userId:string,documentId:string,id:number){return readTransaction(this.db,()=>{this.context(userId,documentId);const row=this.record(documentId,id);metadata(row);return {documentId,publicId:row.publicId,storageId:row.storageId};});}
 authorizeExport(userId:string,documentId:string){return readTransaction(this.db,()=>{if(!this.context(userId,documentId).document.export)throw new DocumentError('ACCESS_DENIED');});}
 exportSnapshot(userId:string,documentId:string){return readTransaction(this.db,()=>{this.authorizeExport(userId,documentId);return this.catalogue.snapshot(documentId);});}
 exportIds(userId:string,documentId:string,after:number,high:number){return readTransaction(this.db,()=>{this.authorizeExport(userId,documentId);return this.catalogue.ascending(documentId,{after,high,limit:50});});}
 legacyMetadata(userId:string,documentId:string,id:number){return readTransaction(this.db,()=>{this.authorizeExport(userId,documentId);const row=this.record(documentId,id);metadata(row);return row.legacy_metadata===null?null:validateLegacyHistoryMetadata(JSON.parse(row.legacy_metadata),65536);});}
 async download(userId:string,documentId:string,id:number,options:{signal?:AbortSignal;authorize?:()=>void;range?:ByteRange}={}){
  const signal=options.signal?AbortSignal.any([this.lifetime.signal,options.signal]):this.lifetime.signal,authorize=options.authorize;
  const authority=()=>readTransaction(this.db,()=>{signal.throwIfAborted();authorize?.();const context=this.context(userId,documentId),item=this.row(documentId,id);if(!context.document.export)throw new DocumentError('ACCESS_DENIED');return item;});
  const item=authority(),range=options.range?{...options.range}:undefined;
  if(range&&(!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end<range.start||range.end>=item.size))throw new DocumentError('INVALID_RANGE');
  const guard=()=>{const current=authority();if(current.sha256!==item.sha256||current.size!==item.size)throw new DocumentError('HISTORY_CORRUPT');};
  await this.integrity.verify(this.store,{digest:item.sha256,size:item.size},signal,guard);guard();const store=this.store;
  async function* contents():AsyncGenerator<Uint8Array>{
   let source:Readable|undefined;const abort=()=>source?.destroy(signal.reason instanceof Error?signal.reason:new DocumentError('HISTORY_INTERRUPTED'));
   try{guard();source=await store.read(item.sha256,range);source.on('error',()=>{});signal.addEventListener('abort',abort,{once:true});guard();for await(const chunk of source){guard();yield chunk as Uint8Array;}guard();}
   catch(error){signal.throwIfAborted();if(error instanceof DocumentError)throw error;throw new DocumentError('HISTORY_UNAVAILABLE');}
   finally{signal.removeEventListener('abort',abort);source?.destroy();}
  }
  return {entry:item,bytes:contents()};
 }
 async close(){this.lifetime.abort(new DocumentError('HISTORY_CLOSED'));await this.integrity.close();}
}
