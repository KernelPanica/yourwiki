import {createHash} from 'node:crypto';
/** Streaming legacy JSON/base64 transport only. Callers publish imports only after full-envelope success. */
export class HistoryArchiveError extends Error{constructor(code:string){super(code);}}
export type LegacyHistoryMetadata=Record<string,unknown>&{saved_at:string;revision:number;kind:string;file_format:string;title:string;author:null|{id:string|number;name:string};sha256:string;state_reference:string};
type Limits={signal?:AbortSignal;maxFileBytes?:number;maxTotalBytes?:number;maxArchiveBytes?:number;maxEntries?:number;maxMetadataBytes?:number};
const invalid=():never=>{throw new HistoryArchiveError('HISTORY_ARCHIVE_INVALID');},limit=():never=>{throw new HistoryArchiveError('HISTORY_ARCHIVE_LIMIT');};
function limits(options:Limits){const values={file:options.maxFileBytes??4*1024**3,total:options.maxTotalBytes??40*1024**3,archive:options.maxArchiveBytes??64*1024**3,entries:options.maxEntries??100000,metadata:options.maxMetadataBytes??64*1024};if(!Object.values(values).every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('Invalid archive limits');return values;}
function metadata(value:Record<string,unknown>,maximum:number):LegacyHistoryMetadata{
 if(Buffer.byteLength(JSON.stringify(value))>maximum)limit();const date=value.saved_at,author=value.author;
 if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==date.slice(0,10)||!Number.isSafeInteger(value.revision)||(value.revision as number)<0||typeof value.kind!=='string'||!['document','table','file','presentation','canvas','drawio'].includes(value.kind)||typeof value.file_format!=='string'||!/^$|^[a-z0-9][a-z0-9.-]{0,31}$/.test(value.file_format)||typeof value.title!=='string'||value.title.length>2000||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||typeof value.state_reference!=='string'||value.state_reference.length>8192||author!==null&&(!author||typeof author!=='object'||Array.isArray(author)||typeof (author as any).name!=='string'||(author as any).name.length>2000||!(typeof (author as any).id==='string'&&(author as any).id.length>0&&(author as any).id.length<=128||Number.isSafeInteger((author as any).id)&&(author as any).id>=0)))invalid();return value as LegacyHistoryMetadata;
}
type Budget={remaining:number};
class Cursor{
 private options:Limits;private iterator:AsyncIterator<string>;private text='';private position=0;size=0;hash=createHash('sha256');
 constructor(source:AsyncIterable<Uint8Array>,options:Limits,maximum:number){this.options=options;const self=this;this.iterator=(async function*(){const decoder=new TextDecoder('utf-8',{fatal:true});try{for await(const chunk of source){options.signal?.throwIfAborted();if(!(chunk instanceof Uint8Array))invalid();self.size+=chunk.byteLength;if(self.size>maximum)limit();self.hash.update(chunk);for(let i=0;i<chunk.length;i+=65536){options.signal?.throwIfAborted();const text=decoder.decode(chunk.subarray(i,i+65536),{stream:true});if(text)yield text;}}const tail=decoder.decode();if(tail)yield tail;}catch(error){if(error instanceof TypeError)invalid();throw error;}})()[Symbol.asyncIterator]();}
 private async next(){
  const signal=this.options.signal;signal?.throwIfAborted();const next=this.iterator.next();if(!signal)return next;let abort:(()=>void)|undefined;
  try{return await Promise.race([next,new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}finally{if(abort)signal.removeEventListener('abort',abort);}
 }
 async ensure(){this.options.signal?.throwIfAborted();while(this.position>=this.text.length){const next=await this.next();if(next.done)return false;this.text=next.value;this.position=0;}return true;}
 async peek(){return await this.ensure()?this.text[this.position]! : '';}
 async take(budget?:Budget){if(!await this.ensure())invalid();if(budget&&--budget.remaining<0)limit();return this.text[this.position++]!;}
 async whitespace(budget?:Budget){while(/[\x20\t\r\n]/.test(await this.peek())&&await this.peek()!=='')await this.take(budget);}
 async expect(value:string,budget?:Budget){if(await this.take(budget)!==value)invalid();}
 async *stringChunks(budget?:Budget):AsyncGenerator<string>{
  await this.expect('"',budget);while(await this.ensure()){
   const rest=this.text.slice(this.position),special=/["\\\x00-\x1f]/.exec(rest),count=special?.index??rest.length;
   if(count){if(budget&&(budget.remaining-=count)<0)limit();this.position+=count;yield rest.slice(0,count);}
   if(!special)continue;const char=await this.take(budget);if(char==='"')return;if(char!=='\\')invalid();const escape=await this.take(budget);
   if(escape==='u'){let hex='';for(let i=0;i<4;i++)hex+=await this.take(budget);if(!/^[a-fA-F0-9]{4}$/.test(hex))invalid();yield String.fromCharCode(parseInt(hex,16));}
   else{const escapes:Record<string,string>={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};if(!Object.hasOwn(escapes,escape))invalid();yield escapes[escape]!;}
  }invalid();
 }
 async string(budget:Budget){let result='';for await(const chunk of this.stringChunks(budget))result+=chunk;return result;}
 async value(budget:Budget,depth=0):Promise<unknown>{
  if(depth>16)limit();await this.whitespace(budget);const char=await this.peek();if(char==='"')return this.string(budget);
  if(char==='{'||char==='['){await this.take(budget);const object=char==='{',result:any=object?Object.create(null):[],seen=new Set<string>();await this.whitespace(budget);const end=object?'}':']';if(await this.peek()===end){await this.take(budget);return object?{...result}:result;}
   for(;;){let key='';if(object){key=await this.string(budget);if(seen.has(key))invalid();seen.add(key);await this.whitespace(budget);await this.expect(':',budget);}const value=await this.value(budget,depth+1);if(object)result[key]=value;else result.push(value);await this.whitespace(budget);const delimiter=await this.take(budget);if(delimiter===end)return object?{...result}:result;if(delimiter!==',')invalid();await this.whitespace(budget);}
  }
  let token='';while(await this.peek()&&!/[\x20\t\r\n,\]}]/.test(await this.peek())){token+=await this.take(budget);if(token.length>128)invalid();}if(!/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(token))invalid();const result=JSON.parse(token);if(typeof result==='number'&&!Number.isFinite(result))invalid();return result;
 }
 async close(){try{void Promise.resolve(this.iterator.return?.()).catch(()=>{});}catch{ /* Source shutdown cannot retain the parser after cancellation. */ }}
}
export async function decodeHistoryArchive<T>(source:AsyncIterable<Uint8Array>,options:Limits&{consume:(content:AsyncIterable<Uint8Array>,index:number)=>Promise<T>;accept:(metadata:LegacyHistoryMetadata,content:T,index:number)=>Promise<void>}){
 const bounds=limits(options),cursor=new Cursor(source,options,bounds.archive);let count=0,total=0;
 async function readEntry(){
  if(count>=bounds.entries)limit();const index=count,budget={remaining:bounds.metadata},value:Record<string,unknown>=Object.create(null),seen=new Set<string>();let token:T|undefined,contentDigest:string|undefined,finished=false;
  await cursor.expect('{');await cursor.whitespace();if(await cursor.peek()==='}')invalid();
  for(;;){const key=await cursor.string(budget);if(seen.has(key))invalid();seen.add(key);await cursor.whitespace();await cursor.expect(':');await cursor.whitespace();
   if(key==='content_base64'){
    async function* contents(){let pending='',padded=false,size=0;const hash=createHash('sha256');for await(const chunk of cursor.stringChunks()){
     options.signal?.throwIfAborted();if(!/^[A-Za-z0-9+/=]*$/.test(chunk)||padded&&chunk.length)invalid();pending+=chunk;const length=pending.length-pending.length%4;if(!length)continue;const encoded=pending.slice(0,length);pending=pending.slice(length);const decoded=Buffer.from(encoded,'base64');if(decoded.toString('base64')!==encoded)invalid();if(encoded.includes('=')){if(pending.length)invalid();padded=true;}size+=decoded.length;total+=decoded.length;if(size>bounds.file||total>bounds.total)limit();hash.update(decoded);if(decoded.length)yield decoded;
    }if(pending)invalid();contentDigest=hash.digest('hex');finished=true;}
    token=await options.consume(contents(),index);if(!finished)throw new HistoryArchiveError('HISTORY_ARCHIVE_UNCONSUMED');
   }else value[key]=await cursor.value(budget);
   await cursor.whitespace();const delimiter=await cursor.take();if(delimiter==='}')break;if(delimiter!==',')invalid();await cursor.whitespace();
  }
  if(!seen.has('content_base64'))invalid();const valid=metadata({...value},bounds.metadata);if(contentDigest!==valid.sha256)throw new HistoryArchiveError('HISTORY_ARCHIVE_CORRUPT');await options.accept(valid,token!,index);count++;
 }
 try{
  await cursor.whitespace();await cursor.expect('{');const seen=new Set<string>();let format:unknown,version:unknown;await cursor.whitespace();
  for(;;){const key=await cursor.string({remaining:128});if(seen.has(key)||!['format','version','entries'].includes(key))invalid();seen.add(key);await cursor.whitespace();await cursor.expect(':');await cursor.whitespace();
   if(key==='entries'){await cursor.expect('[');await cursor.whitespace();if(await cursor.peek()!==']')for(;;){await readEntry();await cursor.whitespace();if(await cursor.peek()===']')break;await cursor.expect(',');await cursor.whitespace();}await cursor.expect(']');}
   else{const value=await cursor.value({remaining:128});if(key==='format')format=value;else version=value;}
   await cursor.whitespace();const delimiter=await cursor.take();if(delimiter==='}')break;if(delimiter!==',')invalid();await cursor.whitespace();
  }await cursor.whitespace();if(await cursor.peek()||seen.size!==3||format!=='yourwiki-history'||version!==1)invalid();return {entries:count,totalBytes:total,size:cursor.size,sha256:cursor.hash.digest('hex')};
 }finally{await cursor.close();}
}
export async function* encodeHistoryArchive(entries:AsyncIterable<{metadata:LegacyHistoryMetadata|Record<string,unknown>;content:AsyncIterable<Uint8Array>}>,options:Limits={}):AsyncGenerator<Uint8Array>{
 const bounds=limits(options);let count=0,total=0,output=0;function emit(text:string){options.signal?.throwIfAborted();const chunk=Buffer.from(text);output+=chunk.length;if(output>bounds.archive)limit();return chunk;}
 yield emit('{"format":"yourwiki-history","version":1,"entries":[');
 for await(const entry of entries){if(count>=bounds.entries)limit();const pinned=metadata(JSON.parse(JSON.stringify(entry.metadata)),bounds.metadata);if(Object.hasOwn(pinned,'content_base64'))invalid();const encoded=JSON.stringify(pinned);yield emit((count?',':'')+encoded.slice(0,-1)+',"content_base64":"');let pending=Buffer.alloc(0),size=0;const hash=createHash('sha256');
  for await(const chunk of entry.content){options.signal?.throwIfAborted();if(!(chunk instanceof Uint8Array))invalid();for(let i=0;i<chunk.length;i+=65536){const part=chunk.subarray(i,i+65536);size+=part.length;total+=part.length;if(size>bounds.file||total>bounds.total)limit();hash.update(part);const merged=Buffer.concat([pending,part]),length=merged.length-merged.length%3;yield emit(merged.subarray(0,length).toString('base64'));pending=Buffer.from(merged.subarray(length));}}
  if(hash.digest('hex')!==pinned.sha256)throw new HistoryArchiveError('HISTORY_ARCHIVE_CORRUPT');if(pending.length)yield emit(pending.toString('base64'));yield emit('"}');count++;
 }yield emit(']}');
}

/** Shared validator for private persisted metadata; never expose the full result in read-only metadata APIs. */
export {metadata as validateLegacyHistoryMetadata};
