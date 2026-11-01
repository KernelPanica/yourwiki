import {transaction,type Database} from './database.ts';
import type {BlobStore} from './storage/blobs.ts';
import {HistoryRead,type HistoryEntry} from './history-read.ts';
import {DocumentError} from './document-errors.ts';
import {encodeHistoryArchive,validateLegacyHistoryMetadata,type LegacyHistoryMetadata} from './history-archive.ts';
function kind(format:string){if(['md','markdown','txt','text','doc','docx','odt','rtf'].includes(format))return 'document';if(['xls','xlsx','ods','csv','tsv'].includes(format))return 'table';if(['ppt','pptx','odp'].includes(format))return 'presentation';if(['canvas','drawio'].includes(format))return format;return 'file';}
/** Exact v1 legacy records, or compatible full-file snapshots for locally captured history. */
export class HistoryExport{
 private db:Database;private reader:HistoryRead;private stop=new AbortController();private pending=new Set<Promise<unknown>>();
 constructor(db:Database,store:BlobStore){this.db=db;this.reader=new HistoryRead(db,store);}
 private metadata(user:string,doc:string,item:HistoryEntry){
  this.reader.entry(user,doc,item.id);const row=this.db.prepare('SELECT metadata_json FROM history_legacy_metadata WHERE entry_id=?').get(item.id) as {metadata_json:string}|undefined;
  if(row)return validateLegacyHistoryMetadata(JSON.parse(row.metadata_json),65536);
  return {saved_at:new Date(item.capturedAt).toISOString(),revision:item.sourceRevision,kind:kind(item.format),file_format:item.format,title:item.title,author:item.author.id?{id:item.author.id,name:item.author.name}:null,sha256:item.sha256,state_reference:''} satisfies LegacyHistoryMetadata;
 }
 open(user:string,doc:string,options:{signal?:AbortSignal;authorize?:()=>void}={}){const task=this.run(user,doc,options);this.pending.add(task);void task.then(()=>this.pending.delete(task),()=>this.pending.delete(task));return task;}
 private async run(user:string,doc:string,options:{signal?:AbortSignal;authorize?:()=>void}){
  const signal=AbortSignal.any([this.stop.signal,...(options.signal?[options.signal]:[])]),reader=this.reader,db=this.db;
  const guard=()=>{signal.throwIfAborted();options.authorize?.();const context=reader.list(user,doc,{limit:1});if(!context.document.export)throw new DocumentError('ACCESS_DENIED');};
  const snapshot=transaction(db,()=>{guard();return db.prepare('SELECT COUNT(*) AS count,COALESCE(MAX(id),0) AS high FROM history_entries WHERE document_id=?').get(doc) as {count:number;high:number};});
  const ids=(after:number)=>(db.prepare('SELECT id FROM history_entries WHERE document_id=? AND id>? AND id<=? ORDER BY id LIMIT 50').all(doc,after,snapshot.high) as {id:number}[]).map(row=>row.id);
  const first=ids(0)[0],prepared=first?await reader.download(user,doc,first,{signal,authorize:options.authorize}):undefined;guard();const metadata=this.metadata.bind(this);
  async function* entries(){let after=0,count=0;for(;;){guard();const page=ids(after);if(!page.length)break;for(const id of page){guard();const value=id===first?prepared!:await reader.download(user,doc,id,{signal,authorize:options.authorize});guard();const original=metadata(user,doc,value.entry);yield {metadata:original,content:value.bytes};after=id;count++;}}guard();if(count!==snapshot.count)throw new DocumentError('HISTORY_CORRUPT');}
  async function* contents(){for await(const chunk of encodeHistoryArchive(entries(),{signal})){guard();yield chunk;}guard();}
  return {entryCount:snapshot.count,bytes:contents()};
 }
 async close(){this.stop.abort(new DocumentError('HISTORY_CLOSED'));await Promise.allSettled([...this.pending]);await this.reader.close();}
}
