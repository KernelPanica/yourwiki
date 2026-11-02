import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {Readable,Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {crc32} from 'node:zlib';
import {openPromise,type Entry} from 'yauzl';
import {ZipFile} from 'yazl';
import {SaxesParser,type SaxesTagNS} from 'saxes';
import {OfficeError} from './errors.ts';
import {legacyMarkdown} from './legacy-markdown.ts';
import {validateOfficeFile,xmlStream} from './validation.ts';
const ns='http://schemas.openxmlformats.org/package/2006/relationships',part='word/_rels/document.xml.rels';
const invalid=():never=>{throw new OfficeError('INVALID_OFFICE_FILE');};
const budget=():never=>{throw new OfficeError('OFFICE_FILE_BUDGET');};
const escape=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;').replace(/\r/g,'&#13;').replace(/\n/g,'&#10;').replace(/\t/g,'&#9;');
function attributes(tag:SaxesTagNS,root=false){
 const declarations=Object.entries(tag.ns).filter(([prefix])=>prefix!==''&&prefix!=='xml').map(([prefix,uri])=>` xmlns:${prefix}="${escape(uri)}"`).join('');
 return (root?` xmlns="${ns}"`:tag.ns['']!==undefined?` xmlns="${ns}"`:'')+declarations+Object.values(tag.attributes).filter(attr=>attr.uri!=='http://www.w3.org/2000/xmlns/').map(attr=>` ${attr.name}="${escape(attr.value)}"`).join('');
}
function relationshipsStream(entry:Entry,limit:number,rewrite=false){
 const parser=new SaxesParser({xmlns:true});let depth=0,prefixed=false,count=0,crc=0;
 const stream=new Transform({
  transform(chunk,_encoding,done){try{count+=chunk.length;if(count>limit)budget();crc=crc32(chunk,crc);xml.write(chunk);done();}catch(error){done(error as Error);}},
  flush(done){try{xml.end();if(count!==entry.uncompressedSize||crc!==entry.crc32)invalid();done();}catch(error){done(error as Error);}},
 });
 parser.on('error',invalid);parser.on('doctype',invalid);parser.on('opentag',tag=>{
  depth++;if(depth===1){if(tag.local!=='Relationships'||tag.uri!==ns)invalid();prefixed=!!tag.prefix;if(rewrite)stream.push('<?xml version="1.0" encoding="utf-8"?><Relationships'+attributes(tag,true)+'>');}
  else if(depth===2){if(tag.local!=='Relationship'||tag.uri!==ns)invalid();if(rewrite)stream.push('<Relationship'+attributes(tag)+'/>');}else invalid();
 });parser.on('closetag',()=>{if(depth===1&&rewrite)stream.push('</Relationships>');depth--;});parser.on('text',text=>{if(text.trim())invalid();});parser.on('cdata',text=>{if(text.trim())invalid();});
 // Reuse the validator's bounded incremental encoding detection and token/attribute budgets.
 const xml=xmlStream(false,parser);return {stream,prefixed:()=>prefixed};
}
/** Bounded subprocess implementation. Originals and unmodified OPC containers are never rewritten. */
export async function transitOfficeFile(path:string,format:string,output:Writable,signal:AbortSignal,options:{maxXmlBytes?:number;maxOutputBytes?:number;maxExpandedBytes?:number;maxTextBytes?:number}={}){
 const xmlLimit=options.maxXmlBytes??options.maxExpandedBytes??40*1024**3,outputLimit=options.maxOutputBytes??4*1024**3,expandedLimit=options.maxExpandedBytes??40*1024**3,textLimit=options.maxTextBytes??16*1024**2;
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
   const relationships=entries.find(entry=>entry.fileName===part);let needsRepair=false;
   if(relationships){if(relationships.uncompressedSize>xmlLimit)budget();const inspection=relationshipsStream(relationships,xmlLimit);await pipeline(await archive.openReadStreamPromise(relationships),inspection.stream,new Writable({write(_chunk,_encoding,done){done();}}),{signal});needsRepair=inspection.prefixed();}
   // Valid documents may omit this optional OPC relationship part entirely.
   if(!needsRepair){await pipeline(createReadStream(path),bounded,{signal});await outputTask;return;}
   const writer=new ZipFile(),zipOutput=writer.outputStream as Readable;
   writer.on('error',(error:Error)=>{zipOutput.destroy(error);for(const stream of active)stream.destroy(error);});
   const writing=pipeline(zipOutput,bounded,{signal});writing.catch(()=>{});
   try{
    for(const entry of entries){
     const metadata={mtime:entry.getLastModDate(),mode:(entry.externalFileAttributes>>>16)||0o100644,fileComment:entry.fileCommentRaw as unknown as string};
     if(entry.fileName.endsWith('/')){if(entry.uncompressedSize)invalid();writer.addEmptyDirectory(entry.fileName,metadata);continue;}
     writer.addReadStreamLazy(entry.fileName,{...metadata,...(entry.fileName===part?{}:{size:entry.uncompressedSize}),compress:entry.compressionMethod!==0,fileComment:entry.fileCommentRaw as unknown as string},callback=>{
      archive.openReadStreamPromise(entry).then(source=>{
       if(signal.aborted){source.destroy();callback(signal.reason,null!);return;}let count=0,crc=0;
       const checked=entry.fileName===part?relationshipsStream(entry,xmlLimit,true).stream:new Transform({transform(chunk,_encoding,done){count+=chunk.length;crc=crc32(chunk,crc);done(null,chunk);},flush(done){done(count===entry.uncompressedSize&&crc===entry.crc32?undefined:new OfficeError('INVALID_OFFICE_FILE'));}});
       active.add(source);active.add(checked);source.once('close',()=>active.delete(source));checked.once('close',()=>active.delete(checked));source.on('error',error=>checked.destroy(error));callback(null,checked);source.pipe(checked);
      },error=>callback(error,null!));
     });
    }
    writer.end({forceZip64Format:false,comment:archive.comment as unknown as string});await writing;await outputTask;
   }catch(error){zipOutput.destroy();for(const stream of active)stream.destroy();await writing.catch(()=>{});throw error;}
  }finally{signal.removeEventListener('abort',abort);archive.close();}
 }catch(error){bounded.destroy(error instanceof Error?error:new Error('Transit failed'));await outputTask.catch(()=>{});if(signal.aborted)signal.throwIfAborted();if(error instanceof OfficeError)throw error;throw new OfficeError('INVALID_OFFICE_FILE');}
}
