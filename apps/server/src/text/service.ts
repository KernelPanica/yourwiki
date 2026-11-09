import {supportsGoogleMarkdown} from '../providers/google-markdown-write.ts';
import {randomUUID} from 'node:crypto';
import {transaction,type Database} from '../database.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {DocumentError} from '../document-errors.ts';
import {ContentParity,boundedRead,type Check} from '../content-parity/service.ts';
import {decode,shape,integer} from '../content-parity/validation.ts';
import {SourceDelivery} from '../providers/delivery-status.ts';
import {decodeTextDocument,encodeVisualDocument} from './codec.ts';
export const textBytes=4*1024**2;
const bytes=(s:string)=>(async function*(){yield Buffer.from(s);})();
/** All editor entry points use the same file ACL, revisions, history and source
 * delivery queue. Rejected saves retain a private, author-bound recovery blob. */
export class TextDocuments{
 readonly content:ContentParity;private db:Database;private store:BlobStore;
 constructor(db:Database,store:BlobStore){this.db=db;this.store=store;this.content=new ContentParity(db,store);}
 private text(user:string,id:string,write=false){const doc=this.content.visible(user,id,write);if(!['md','markdown','txt','text'].includes(doc.format))throw new DocumentError('TEXT_FORMAT_UNSUPPORTED');return doc;}
 async read(user:string,id:string,check:Check){const doc=this.text(user,id),ref=this.content.source(user,id).ref,source=decode(await boundedRead(this.store,ref,textBytes,()=>{check();this.text(user,id);}));check();const current=this.text(user,id);if(current.revision!==doc.revision)throw new DocumentError('CONFLICT');return {documentId:id,title:(this.db.prepare('SELECT title FROM documents WHERE id=?').get(id) as {title:string}).title,revision:doc.revision,format:doc.format,source,...decodeTextDocument(source),write:doc.write,export:doc.export,saveBlockedReason:this.google(id)?'SOURCE_SAVE_UNSUPPORTED':null,delivery:new SourceDelivery(this.db,this.store).status(user,id)};}
 private google(id:string){const binding=this.db.prepare("SELECT d.format,b.fingerprint FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id JOIN documents d ON d.id=b.document_id WHERE b.document_id=? AND c.provider='google'").get(id) as {format:string;fingerprint:string}|undefined;return !!binding&&!supportsGoogleMarkdown(binding.format,binding.fingerprint);}
 async create(user:string,input:unknown,check:Check){const value=shape(input,['title','parentId'],['groupId','source']);if(typeof value.title!=='string'||typeof value.source!=='string'&&value.source!==undefined)throw new DocumentError('INVALID_REQUEST');const source=value.source??'# '+value.title.replace(/\.md$/i,'')+'\n';if(Buffer.byteLength(source)>textBytes)throw new DocumentError('PAYLOAD_TOO_LARGE');check();const result=await this.content.documents.create({userId:user,title:value.title,format:'md',parentId:value.parentId,groupId:value.groupId},bytes(source));check();return {documentId:result.documentId,revision:1,jobId:result.jobId};}
 async save(user:string,id:string,input:unknown,check:Check){const value=shape(input,['baseRevision','mode'],['source','markdown','document']);integer(value.baseRevision,1);if(!['source','visual'].includes(value.mode)||value.mode==='source'&&typeof value.source!=='string'||value.mode==='visual'&&value.markdown!==undefined&&typeof value.markdown!=='string')throw new DocumentError('INVALID_REQUEST');this.text(user,id,true);check();let source:string;
  if(value.mode==='source')source=value.source;else{const current=await this.read(user,id,check);source=encodeVisualDocument(current.source,{markdown:value.markdown,document:value.document});}
  if(Buffer.byteLength(source)>textBytes)throw new DocumentError('PAYLOAD_TOO_LARGE');const blob=await this.store.put(bytes(source),{maxBytes:textBytes});
  try{return transaction(this.db,()=>{check();this.text(user,id,true);if(this.google(id))throw new DocumentError('SOURCE_SAVE_UNSUPPORTED');this.content.documents.checkSave({userId:user,documentId:id,baseRevision:value.baseRevision});const existing=this.db.prepare('SELECT digest FROM document_versions WHERE document_id=? AND revision=?').get(id,value.baseRevision) as {digest:string};if(existing.digest===blob.digest)return {revision:value.baseRevision,delivery:new SourceDelivery(this.db,this.store).status(user,id)};const result=this.content.documents.commitPreparedSave({userId:user,documentId:id,baseRevision:value.baseRevision},blob);this.db.prepare("INSERT INTO events(kind,document_id,payload,created_at) VALUES('text.saved',?,'{}',?)").run(id,Date.now());return {revision:result.revision,jobId:result.jobId,delivery:new SourceDelivery(this.db,this.store).status(user,id)};});}
  catch(error){const reason=error instanceof DocumentError?error.code:'SAVE_FAILED',recoveryId=randomUUID();this.db.prepare('INSERT INTO recovery_copies(id,document_id,intended_document_id,author_id,digest,size,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(recoveryId,this.db.prepare('SELECT 1 FROM documents WHERE id=?').get(id)?id:null,id,this.db.prepare('SELECT 1 FROM users WHERE id=?').get(user)?user:null,blob.digest,blob.size,reason,Date.now());throw new DocumentError(reason,recoveryId);}
 }
}
