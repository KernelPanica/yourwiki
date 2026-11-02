import type {Database} from './database.ts';
import type {BlobStore} from './storage/blobs.ts';
import {HistoryRead,type HistoryEntry} from './history-read.ts';
import {DocumentError} from './document-errors.ts';
import {encodeHistoryArchive,type LegacyHistoryMetadata} from './history-archive.ts';
function kind(format:string){if(['md','markdown','txt','text','doc','docx','odt','rtf'].includes(format))return 'document';if(['xls','xlsx','ods','csv','tsv'].includes(format))return 'table';if(['ppt','pptx','odp'].includes(format))return 'presentation';if(['canvas','drawio'].includes(format))return format;return 'file';}
/** Exact v1 legacy records, or compatible full-file snapshots for locally captured history. */
export class HistoryExport{
 private reader:HistoryRead;private stop=new AbortController();private pending=new Set<Promise<unknown>>();
 constructor(db:Database,store:BlobStore){this.reader=new HistoryRead(db,store);}
 private metadata(user:string,doc:string,item:HistoryEntry){
  const original=this.reader.legacyMetadata(user,doc,item.id);if(original)return original;
  return {saved_at:new Date(item.capturedAt).toISOString(),revision:item.sourceRevision,kind:kind(item.format),file_format:item.format,title:item.title,author:item.author.id?{id:item.author.id,name:item.author.name}:null,sha256:item.sha256,state_reference:''} satisfies LegacyHistoryMetadata;
 }
 open(user:string,doc:string,options:{signal?:AbortSignal;authorize?:()=>void}={}){const task=this.run(user,doc,options);this.pending.add(task);void task.then(()=>this.pending.delete(task),()=>this.pending.delete(task));return task;}
 private async run(user:string,doc:string,options:{signal?:AbortSignal;authorize?:()=>void}){
  const signal=AbortSignal.any([this.stop.signal,...(options.signal?[options.signal]:[])]),reader=this.reader;
  const guard=()=>{signal.throwIfAborted();options.authorize?.();reader.authorizeExport(user,doc);};
  guard();const snapshot=reader.exportSnapshot(user,doc);
  const ids=(after:number)=>reader.exportIds(user,doc,after,snapshot.high);
  const first=ids(0)[0],prepared=first?await reader.download(user,doc,first,{signal,authorize:options.authorize}):undefined;guard();const metadata=this.metadata.bind(this);
  async function* entries(){let after=0,count=0;for(;;){guard();const page=ids(after);if(!page.length)break;for(const id of page){guard();const value=id===first?prepared!:await reader.download(user,doc,id,{signal,authorize:options.authorize});guard();const original=metadata(user,doc,value.entry);yield {metadata:original,content:value.bytes};after=id;count++;}}guard();if(count!==snapshot.count)throw new DocumentError('HISTORY_CORRUPT');}
  async function* contents(){for await(const chunk of encodeHistoryArchive(entries(),{signal})){guard();yield chunk;}guard();}
  return {entryCount:snapshot.count,bytes:contents()};
 }
 async close(){this.stop.abort(new DocumentError('HISTORY_CLOSED'));await Promise.allSettled([...this.pending]);await this.reader.close();}
}
