import type {Database} from '../database.ts';
import {transaction} from '../database.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {DocumentService} from '../documents.ts';
import {boundedRead} from '../content-parity/service.ts';
import {rewriteDocumentLinks,type LinkMap} from './native-link-content.ts';

export type MigrationLink={document_id:string;original_reference:string;destination_reference:string;format:string};
export function migrationLinks(db:Database,connectionId:string):MigrationLink[]{
 const rows=db.prepare(`SELECT m.document_id,m.original_reference,m.destination_reference,d.format,b.reference,c.enabled
 FROM rclone_native_migrations m JOIN documents d ON d.id=m.document_id
 LEFT JOIN provider_source_bindings b ON b.document_id=m.document_id AND b.connection_id=m.connection_id
 JOIN provider_connections c ON c.id=m.connection_id WHERE m.connection_id=? AND m.committed_at IS NOT NULL ORDER BY m.document_id`).all(connectionId) as (MigrationLink&{reference:string|null;enabled:number})[];
 for(const row of rows)if(!row.enabled||row.reference!==row.destination_reference||!/^[-\w]{1,256}$/.test(row.original_reference)||!/^[-\w]{1,256}$/.test(row.destination_reference))throw Error('MIGRATION_TARGET_NOT_BOUND');
 return rows.map(({document_id,original_reference,destination_reference,format})=>({document_id,original_reference,destination_reference,format}));
}
type Source={id:string;title:string;format:string;revision:number;digest:string;size:number};
export type LinkScan=Source&{count:number;supported:boolean;error?:string};
const sources=`SELECT d.id,d.title,d.format,d.local_revision AS revision,v.digest,v.size
 FROM documents d JOIN resources r ON r.id=d.id JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision
 WHERE r.trashed=0 ORDER BY d.id`;

export class NativeLinkCleanup{
 private db:Database;private store:BlobStore;private mapping:LinkMap;private actor:string;private docs:DocumentService;
 constructor(db:Database,store:BlobStore,mapping:LinkMap,actor:string){this.db=db;this.store=store;this.mapping=mapping;this.actor=actor;this.docs=new DocumentService(db,store);}
 assertStable(plan:LinkScan[]){
  const current=this.db.prepare(sources).all() as Source[];
  const snapshot=plan.map(({id,title,format,revision,digest,size})=>({id,title,format,revision,digest,size}));
  if(JSON.stringify(current)!==JSON.stringify(snapshot))throw Error('DOCUMENTS_CHANGED_SINCE_SCAN');
 }
 assertSynchronized(plan:LinkScan[]){
  this.assertStable(plan);
  if(plan.some(row=>row.error||!row.supported||row.count))throw Error('LINK_SCAN_INCOMPLETE_OR_OLD_LINKS_REMAIN');
  for(const row of plan)this.assertSourceReady(row.id);
 }
 private assertSourceReady(id:string){
  if(this.db.prepare(`SELECT 1 FROM documents d JOIN provider_source_bindings b ON b.document_id=d.id
   WHERE d.id=? AND (d.provider_revision IS NOT d.local_revision OR b.confirmed_revision!=d.local_revision)`).get(id)
   ||this.db.prepare("SELECT 1 FROM provider_ingress_snapshots WHERE document_id=? AND state IN ('pending','receiving','staged','conflict')").get(id)
   ||this.db.prepare("SELECT 1 FROM provider_delivery_attempts WHERE document_id=? AND state NOT IN ('confirmed','retired')").get(id))throw Error('SOURCE_NOT_SYNCHRONIZED');
 }
 async scan():Promise<LinkScan[]>{
  const rows=this.db.prepare(sources).all() as Source[],result:LinkScan[]=[];
  for(const row of rows){
   try{
    if(!await this.store.verify(row))throw Error('CORRUPT_SOURCE_BLOB');
    const data=await boundedRead(this.store,row,256*1024**2);
    const rewritten=await rewriteDocumentLinks(data,row.format,this.mapping);
    if(rewritten.count){this.assertSourceReady(row.id);this.docs.checkSave({userId:this.actor,documentId:row.id,baseRevision:row.revision});}
    result.push({...row,count:rewritten.count,supported:rewritten.supported});
   }catch(error){result.push({...row,count:0,supported:false,error:error instanceof Error?error.message:'SCAN_FAILED'});}
  }
  this.assertStable(result);return result;
 }
 async apply(plan:LinkScan[],record:(event:Record<string,unknown>)=>void|Promise<void>=()=>{},check:()=>void=()=>{}){
  if(plan.some(row=>row.error))throw Error('SCAN_ERRORS');
  this.assertStable(plan);
  for(const row of plan.filter(row=>row.count)){
   check();this.assertSourceReady(row.id);
   const current=this.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(row.id) as {local_revision:number};
   if(current.local_revision!==row.revision)throw Error('DOCUMENT_CHANGED_SINCE_SCAN');
   const source=await boundedRead(this.store,row,256*1024**2),rewritten=await rewriteDocumentLinks(source,row.format,this.mapping);
   if(rewritten.count!==row.count)throw Error('LINK_PLAN_CHANGED');
   const blob=await this.store.put((async function*(){yield rewritten.data;})(),{maxBytes:256*1024**2});
   await record({event:'save-planned',id:row.id,baseRevision:row.revision,before:row.digest,after:blob.digest,links:row.count});
   const saved=transaction(this.db,()=>{check();this.assertSourceReady(row.id);return this.docs.commitPreparedSave({userId:this.actor,documentId:row.id,baseRevision:row.revision},blob);});
   await record({event:'saved',id:row.id,revision:saved.revision});
  }
 }
}
