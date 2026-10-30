import {SaxesParser} from 'saxes';
import {openPromise,type Entry} from 'yauzl';
import {crc32} from 'node:zlib';
import type {Readable} from 'node:stream';
import type {BlobStore,BlobRef} from '../storage/blobs.ts';
import {OfficeError} from './errors.ts';
const text=new Set(['md','txt','csv','tsv','dif','slk']),ole=new Set(['doc','xls','ppt','xla']);
const parts:Record<string,string>={docx:'word/document.xml',docm:'word/document.xml',dotx:'word/document.xml',dotm:'word/document.xml',xlsx:'xl/workbook.xml',xlsm:'xl/workbook.xml',xltx:'xl/workbook.xml',xltm:'xl/workbook.xml',xlsb:'xl/workbook.bin',pptx:'ppt/presentation.xml',pptm:'ppt/presentation.xml',potx:'ppt/presentation.xml',potm:'ppt/presentation.xml',ppsx:'ppt/presentation.xml'};
const odf:Record<string,string>={odt:'text',ods:'spreadsheet',odp:'presentation',odg:'graphics',odm:'text-master',ott:'text-template',ots:'spreadsheet-template',otp:'presentation-template',oth:'text-web'};
const invalid=()=>{throw new OfficeError('INVALID_OFFICE_FILE');};
function parserBudget(parser:SaxesParser){
 const state=parser as unknown as Record<string,unknown>;for(const key of ['name','text','piTarget','entity','attribValue'])if(typeof state[key]==='string'&&state[key].length>1024**2)throw new OfficeError('OFFICE_FILE_BUDGET');
 if(Array.isArray(state.attribList)){
  if(state.attribList.length>10000)throw new OfficeError('OFFICE_FILE_BUDGET');let total=0;for(const item of state.attribList){for(const field of ['name','value'])if(typeof item[field]==='string')total+=item[field].length;if(total>1024**2)throw new OfficeError('OFFICE_FILE_BUDGET');}
 }
}
function xmlParser(flat=false){
 let depth=0;const parser=new SaxesParser({xmlns:true});parser.on('doctype',invalid);parser.on('error',invalid);
 parser.on('opentag',tag=>{if(++depth>256)throw new OfficeError('OFFICE_FILE_BUDGET');if(flat&&depth===1&&(tag.local!=='document'||tag.uri!=='urn:oasis:names:tc:opendocument:xmlns:office:1.0'))invalid();});parser.on('closetag',()=>{depth--;});return parser;
}
function xmlStream(flat=false){
 const parser=xmlParser(flat);let prefix=Buffer.alloc(0),decoder:TextDecoder|undefined;
 function select(final=false){
  if(!final&&prefix.length<8)return;
  let encoding:string;
  if((prefix[0]===0xff&&prefix[1]===0xfe)||(prefix[0]===0x3c&&prefix[1]===0))encoding='utf-16le';
  else if((prefix[0]===0xfe&&prefix[1]===0xff)||(prefix[0]===0&&prefix[1]===0x3c))encoding='utf-16be';
  else{
   const header=prefix.toString('latin1').replace(/^\xef\xbb\xbf/,'');
   if(!final&&header.startsWith('<?xml')&&!header.includes('?>')&&prefix.length<256)return;
   encoding=/\bencoding\s*=\s*["']([^"']{1,64})["']/i.exec(header.split('?>')[0]!)?.[1]??'utf-8';
  }
  decoder=new TextDecoder(encoding,{fatal:true});parser.write(decoder.decode(prefix,{stream:true}));prefix=Buffer.alloc(0);parserBudget(parser);
 }
 return {write(chunk:Buffer){
  if(!decoder){const count=Math.min(256-prefix.length,chunk.length);prefix=Buffer.concat([prefix,chunk.subarray(0,count)]);select();if(!decoder)return;chunk=chunk.subarray(count);}
  parser.write(decoder.decode(chunk,{stream:true}));parserBudget(parser);
 },end(){if(!decoder)select(true);parser.write(decoder!.decode()).close();}};
}
async function consume(stream:Readable,signal:AbortSignal,limit:number,consumer:(data:Buffer)=>void,expected?:Entry){
 const abort=()=>stream.destroy(new OfficeError('OFFICE_VALIDATION_TIMEOUT'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();let count=0,crc=0;
 try{for await(const data of stream){signal.throwIfAborted();const chunk=Buffer.from(data);count+=chunk.length;if(count>limit)throw new OfficeError('OFFICE_FILE_BUDGET');crc=crc32(chunk,crc);consumer(chunk);}if(expected&&(count!==expected.uncompressedSize||crc!==expected.crc32))invalid();}
 finally{signal.removeEventListener('abort',abort);stream.destroy();}
}
/** Stream local file and selected archive parts; never materialize an entire office file. */
export async function validateOfficeFile(store:Pick<BlobStore,'read'|'localFile'>,value:BlobRef,format:string,options:{signal?:AbortSignal;maxExpandedBytes?:number;timeoutMs?:number}={}){
 const blob={...value};
 const maximum=options.maxExpandedBytes??40*1024**3,timeout=options.timeoutMs??60000;
 if(!Number.isSafeInteger(maximum)||maximum<1||!Number.isSafeInteger(timeout)||timeout<1||timeout>3600000)throw new Error('Invalid office validation limits');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout),signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
 try{
  signal.throwIfAborted();if(blob.size===0&&!text.has(format))invalid();
  if(text.has(format)){
   const decoder=new TextDecoder('utf-8',{fatal:true});await consume(await store.read(blob.digest),signal,blob.size,chunk=>{if(decoder.decode(chunk,{stream:true}).includes('\0'))invalid();});decoder.decode();return;
  }
  if(ole.has(format)||format==='rtf'||format==='dbf'){
   const amount=Math.min(blob.size,64);if(!amount)invalid();const values:Buffer[]=[];await consume(await store.read(blob.digest,{start:0,end:amount-1}),signal,64,chunk=>{values.push(chunk);});const header=Buffer.concat(values);
   if(ole.has(format)){if(!header.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex')))invalid();}
   else if(format==='rtf'){if(!header.toString('latin1').trimStart().startsWith('{\\rtf'))invalid();}
   else if(blob.size<32||![3,4,5,0x30,0x31,0x32,0x43,0x63,0x83,0x8b,0xcb,0xf5].includes(header[0]!))invalid();return;
  }
  if(['fodt','fods','fodp','fodg'].includes(format)){
   const xml=xmlStream(true);await consume(await store.read(blob.digest),signal,maximum,chunk=>xml.write(chunk));xml.end();return;
  }
  if(!parts[format]&&!odf[format])invalid();
  const archive=await openPromise(await store.localFile(blob.digest),{autoClose:false,lazyEntries:true,strictFileNames:true,validateEntrySizes:true}),entries=new Map<string,Entry>();let expanded=0;
  const close=()=>archive.close();signal.addEventListener('abort',close,{once:true});if(signal.aborted){archive.close();signal.throwIfAborted();}
  try{
   for await(const entry of archive.eachEntry()){
    signal.throwIfAborted();if(entries.size>=1000)throw new OfficeError('OFFICE_FILE_BUDGET');
    if(entries.has(entry.fileName)||entry.isEncrypted()||entry.fileName.split('/').some(part=>part==='..')||entry.fileName.includes('\\')||entry.fileName.startsWith('/'))invalid();
    expanded+=entry.uncompressedSize;if(!Number.isSafeInteger(expanded)||expanded>maximum)throw new OfficeError('OFFICE_FILE_BUDGET');entries.set(entry.fileName,entry);
   }
   const checkXml=async(name:string)=>{
    const entry=entries.get(name);if(!entry)invalid();const xml=xmlStream();await consume(await archive.openReadStreamPromise(entry!),signal,maximum,chunk=>xml.write(chunk),entry);xml.end();
   };
   if(parts[format]){if(!entries.has('[Content_Types].xml'))invalid();await checkXml('[Content_Types].xml');if(format==='xlsb'){const entry=entries.get(parts[format]!);if(!entry)invalid();await consume(await archive.openReadStreamPromise(entry!),signal,maximum,()=>{},entry);}else await checkXml(parts[format]!);}
   else{
    const entry=entries.get('mimetype');if(!entry||entry.uncompressedSize>256)invalid();let mime='';await consume(await archive.openReadStreamPromise(entry!),signal,256,chunk=>{mime+=chunk.toString('ascii');},entry);
    if(mime!=='application/vnd.oasis.opendocument.'+odf[format])invalid();await checkXml('content.xml');
   }
  }finally{signal.removeEventListener('abort',close);archive.close();}
 }catch(error){if(signal.aborted)throw new OfficeError('OFFICE_VALIDATION_TIMEOUT');if(error instanceof OfficeError)throw error;throw new OfficeError('INVALID_OFFICE_FILE');}
 finally{clearTimeout(timer);}
}
