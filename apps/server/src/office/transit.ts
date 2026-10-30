import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {Readable,Transform,type Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {crc32} from 'node:zlib';
import {openPromise,type Entry} from 'yauzl';
import {ZipFile} from 'yazl';
import {SaxesParser,type SaxesTagNS} from 'saxes';
import {OfficeError} from './errors.ts';
import {legacyMarkdown} from './legacy-markdown.ts';
import {validateOfficeFile} from './validation.ts';
const ns='http://schemas.openxmlformats.org/package/2006/relationships',part='word/_rels/document.xml.rels';
const invalid=():never=>{throw new OfficeError('INVALID_OFFICE_FILE');};
const budget=():never=>{throw new OfficeError('OFFICE_FILE_BUDGET');};
const escape=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;').replace(/\r/g,'&#13;').replace(/\n/g,'&#10;').replace(/\t/g,'&#9;');
function attributes(tag:SaxesTagNS,root=false){
 const declarations=Object.entries(tag.ns).filter(([prefix])=>prefix!==''&&prefix!=='xml').map(([prefix,uri])=>` xmlns:${prefix}="${escape(uri)}"`).join('');
 return (root?` xmlns="${ns}"`:tag.ns['']!==undefined?` xmlns="${ns}"`:'')+declarations+Object.values(tag.attributes).filter(attr=>attr.uri!=='http://www.w3.org/2000/xmlns/').map(attr=>` ${attr.name}="${escape(attr.value)}"`).join('');
}
function repair(data:Buffer){
 let encoding='utf-8';if(data[0]===0xff&&data[1]===0xfe||data[0]===0x3c&&data[1]===0)encoding='utf-16le';else if(data[0]===0xfe&&data[1]===0xff||data[0]===0&&data[1]===0x3c)encoding='utf-16be';else encoding=/\bencoding\s*=\s*["']([^"']{1,64})["']/i.exec(data.subarray(0,256).toString('latin1').split('?>')[0]!)?.[1]??encoding;
 const text=new TextDecoder(encoding,{fatal:true}).decode(data),parser=new SaxesParser({xmlns:true});let depth=0,prefixed=false,root='',children:string[]=[];
 parser.on('error',invalid);parser.on('doctype',invalid);parser.on('opentag',tag=>{
  depth++;if(depth===1){if(tag.local!=='Relationships'||tag.uri!==ns)invalid();prefixed=!!tag.prefix;root='<Relationships'+attributes(tag,true)+'>';}
  else if(depth===2){if(tag.local!=='Relationship'||tag.uri!==ns)invalid();children.push('<Relationship'+attributes(tag)+'/>');}else invalid();
 });parser.on('closetag',()=>{depth--;});parser.on('text',text=>{if(text.trim())invalid();});parser.on('cdata',text=>{if(text.trim())invalid();});parser.write(text).close();
 return prefixed?Buffer.from('<?xml version="1.0" encoding="utf-8"?>'+root+children.join('')+'</Relationships>'):null;
}
async function collect(stream:Readable,entry:Entry,signal:AbortSignal,limit:number){
 const chunks:Buffer[]=[];let size=0,crc=0;const abort=()=>stream.destroy(signal.reason);signal.addEventListener('abort',abort,{once:true});
 try{signal.throwIfAborted();for await(const chunk of stream){signal.throwIfAborted();size+=chunk.length;if(size>limit)budget();crc=crc32(chunk,crc);chunks.push(chunk);}if(size!==entry.uncompressedSize||crc!==entry.crc32)invalid();return Buffer.concat(chunks);}
 finally{signal.removeEventListener('abort',abort);stream.destroy();}
}
/** Bounded subprocess implementation. Originals and unmodified OPC containers are never rewritten. */
export async function transitOfficeFile(path:string,format:string,output:Writable,signal:AbortSignal,options:{maxXmlBytes?:number;maxOutputBytes?:number;maxExpandedBytes?:number;maxTextBytes?:number}={}){
 const xmlLimit=options.maxXmlBytes??1024**2,outputLimit=options.maxOutputBytes??4*1024**3,expandedLimit=options.maxExpandedBytes??40*1024**3,textLimit=options.maxTextBytes??16*1024**2;
 if(![xmlLimit,outputLimit,expandedLimit,textLimit].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('Invalid transit limits');
 let emitted=0;const bounded=new Transform({transform(chunk,_encoding,done){emitted+=chunk.length;if(emitted>outputLimit)done(new OfficeError('OFFICE_FILE_BUDGET'));else done(null,chunk);}});
 const outputTask=pipeline(bounded,output,{signal});outputTask.catch(()=>{});
 try{
  const size=(await stat(path)).size;signal.throwIfAborted();
  await validateOfficeFile({read:async(_digest,range)=>createReadStream(path,range),localFile:async()=>path},{digest:'0'.repeat(64),size},format,{signal,maxExpandedBytes:expandedLimit});
  if(format==='md'){
   if(size>textLimit)budget();const data:Buffer[]=[];for await(const chunk of createReadStream(path,{signal})){data.push(chunk);}const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(data));
   let converted:string;try{converted=legacyMarkdown(text,Math.min(textLimit,outputLimit));}catch(error){if(error instanceof Error&&error.message==='PREVIEW_TOO_COMPLEX')budget();invalid();}
   await pipeline(Readable.from([Buffer.from(converted!)]),bounded,{signal});await outputTask;return;
  }
  if(!['docx','docm','dotx','dotm'].includes(format)){await pipeline(createReadStream(path),bounded,{signal});await outputTask;return;}
  const archive=await openPromise(path,{autoClose:false,lazyEntries:true,strictFileNames:true,validateEntrySizes:true});const active=new Set<Readable>(),abort=()=>{archive.close();for(const stream of active)stream.destroy(signal.reason);};signal.addEventListener('abort',abort,{once:true});
  try{
   signal.throwIfAborted();const entries:Entry[]=[];let expanded=0;for await(const entry of archive.eachEntry()){signal.throwIfAborted();if(entries.length>=1000)budget();expanded+=entry.uncompressedSize;if(expanded>expandedLimit)budget();entries.push(entry);}
   const relationships=entries.find(entry=>entry.fileName===part);let replacement:Buffer|null=null;
   if(relationships){if(relationships.uncompressedSize>xmlLimit)budget();replacement=repair(await collect(await archive.openReadStreamPromise(relationships),relationships,signal,xmlLimit));}
   // Valid documents may omit this optional OPC relationship part entirely.
   if(!replacement){await pipeline(createReadStream(path),bounded,{signal});await outputTask;return;}
   const writer=new ZipFile(),zipOutput=writer.outputStream as Readable;
   writer.on('error',(error:Error)=>{zipOutput.destroy(error);for(const stream of active)stream.destroy(error);});
   const writing=pipeline(zipOutput,bounded,{signal});writing.catch(()=>{});
   try{
    for(const entry of entries){
     const metadata={mtime:entry.getLastModDate(),mode:(entry.externalFileAttributes>>>16)||0o100644,fileComment:entry.fileCommentRaw as unknown as string};
     if(entry.fileName.endsWith('/')){if(entry.uncompressedSize)invalid();writer.addEmptyDirectory(entry.fileName,metadata);continue;}
     if(entry.fileName===part){writer.addBuffer(replacement,part,metadata);continue;}
     writer.addReadStreamLazy(entry.fileName,{...metadata,size:entry.uncompressedSize,compress:entry.compressionMethod!==0,fileComment:entry.fileCommentRaw as unknown as string},callback=>{
      archive.openReadStreamPromise(entry).then(source=>{
       if(signal.aborted){source.destroy();callback(signal.reason,null!);return;}let count=0,crc=0;
       const checked=new Transform({transform(chunk,_encoding,done){count+=chunk.length;crc=crc32(chunk,crc);done(null,chunk);},flush(done){done(count===entry.uncompressedSize&&crc===entry.crc32?undefined:new OfficeError('INVALID_OFFICE_FILE'));}});
       active.add(source);active.add(checked);source.once('close',()=>active.delete(source));checked.once('close',()=>active.delete(checked));source.on('error',error=>checked.destroy(error));callback(null,checked);source.pipe(checked);
      },error=>callback(error,null!));
     });
    }
    writer.end({forceZip64Format:false,comment:archive.comment as unknown as string});await writing;await outputTask;
   }catch(error){zipOutput.destroy();for(const stream of active)stream.destroy();await writing.catch(()=>{});throw error;}
  }finally{signal.removeEventListener('abort',abort);archive.close();}
 }catch(error){bounded.destroy(error instanceof Error?error:new Error('Transit failed'));await outputTask.catch(()=>{});if(signal.aborted)signal.throwIfAborted();if(error instanceof OfficeError)throw error;throw new OfficeError('INVALID_OFFICE_FILE');}
}
