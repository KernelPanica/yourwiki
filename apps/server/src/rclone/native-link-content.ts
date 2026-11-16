import {fromBufferPromise} from 'yauzl';
import {ZipFile} from 'yazl';
import type {Readable} from 'node:stream';
import {crc32,inflateRawSync,deflateRawSync} from 'node:zlib';

export type LinkMap=ReadonlyMap<string,string>;
export type LinkRewrite={data:Buffer;count:number;supported:boolean};
const textFormats=new Set(['md','markdown','txt','text','csv','tsv','json','canvas','drawio','xml','html','htm','svg']);
const archiveFormats=new Set(['docx','xlsx','pptx','docm','xlsm','pptm','dotx','dotm','xltx','xltm','potx','potm','ppsx','odt','ods','odp','odg','ott','ots','otp']);

/** Replace whole Google URLs, never bare IDs or filenames. Native editor anchors
 * (heading/gid/slide IDs) have no reliable meaning in the exported binary. */
export function rewriteGoogleLinks(text:string,mapping:LinkMap):{text:string;count:number}{
 let count=0;
 const output=text.replace(/https?:(?:\\\/|\\u0026|[^\s<>"'`()\[\]{}\\])+/gi,candidate=>{
  const boundary=candidate.search(/&(?:quot|apos|lt|gt|#(?:34|39|60|62)|#x(?:22|27|3c|3e));/i);
  let suffix=boundary<0?'':candidate.slice(boundary);if(boundary>=0)candidate=candidate.slice(0,boundary);
  const punctuation=candidate.search(/[,;]/),query=candidate.search(/[?#]/);
  if(punctuation>=0&&(query<0||punctuation<query)){suffix=candidate.slice(punctuation)+suffix;candidate=candidate.slice(0,punctuation);}
  const trailing=candidate.match(/[.,;!]+$/)?.[0]??'',raw=trailing?candidate.slice(0,-trailing.length):candidate;
  const escaped=raw.includes('\\/');let url:URL;
  try{url=new URL(raw.replace(/\\\//g,'/').replace(/&amp;|&#38;|&#x26;/gi,'&').replace(/\\u0026/gi,'&'));}catch{return candidate+suffix;}
  if(!['docs.google.com','drive.google.com'].includes(url.hostname)||url.username||url.password||url.port)return candidate+suffix;
  const id=url.pathname.match(/^\/(?:document|spreadsheets|presentation)(?:\/u\/\d+)?\/d\/([-\w]+)(?:\/|$)/)?.[1]
   ??url.pathname.match(/^\/file(?:\/u\/\d+)?\/d\/([-\w]+)(?:\/|$)/)?.[1]
   ??(['/open','/uc'].includes(url.pathname)?url.searchParams.get('id'):null);
  const replacement=id?mapping.get(id):undefined;if(!replacement)return candidate+suffix;
  count++;const target='https://drive.google.com/file/d/'+replacement+'/view';
  return (escaped?target.replace(/\//g,'\\/'):target)+trailing+suffix;
 });
 return {text:output,count};
}

function rewriteDelimited(text:string,mapping:LinkMap,tsv:boolean){
 const bom=text.startsWith('\ufeff')?'\ufeff':'';if(bom)text=text.slice(1);
 let quoted=false,commas=0,semicolons=0;
 for(let i=0;i<text.length;i++){
  const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){i++;continue;}quoted=!quoted;}
  if(!quoted){if(c==='\r'||c==='\n')break;if(c===',')commas++;if(c===';')semicolons++;}
 }
 const delimiter=tsv?'\t':semicolons>commas?';':',';
 const output:string[]=[bom];let start=0,count=0;quoted=false;
 const field=(end:number)=>{
  const raw=text.slice(start,end),wrapped=raw.startsWith('"');
  if(wrapped&&!raw.endsWith('"'))throw Error('INVALID_DELIMITED_TEXT');
  const value=wrapped?raw.slice(1,-1).replace(/""/g,'"'):raw;
  const fixed=rewriteGoogleLinks(value,mapping);count+=fixed.count;
  output.push(!fixed.count?raw:wrapped?'"'+fixed.text.replace(/"/g,'""')+'"':fixed.text);
 };
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(c==='"'){
   if(quoted&&text[i+1]==='"'){i++;continue;}
   if(!quoted&&i!==start)throw Error('INVALID_DELIMITED_TEXT');quoted=!quoted;
  }else if(!quoted&&(c===delimiter||c==='\r'||c==='\n')){field(i);output.push(c);start=i+1;}
 }
 if(quoted)throw Error('INVALID_DELIMITED_TEXT');field(text.length);
 return {text:output.join(''),count};
}

function transformText(data:Buffer,mapping:LinkMap,drawio=false,limit=64*1024**2,delimited?:'csv'|'tsv'){
 const be=data[0]===0xfe&&data[1]===0xff,le=data[0]===0xff&&data[1]===0xfe;
 const source=be?Buffer.from(data).swap16():data;
 const text=new TextDecoder(le||be?'utf-16le':'utf-8',{fatal:true,ignoreBOM:true}).decode(source);
 const direct=delimited?rewriteDelimited(text,mapping,delimited==='tsv'):rewriteGoogleLinks(text,mapping);let count=direct.count,output=direct.text;
 if(drawio)output=output.replace(/(<diagram\b[^>]*>)([^<]+)(<\/diagram>)/g,(whole,open,encoded,close)=>{
  if(!encoded.trim())return whole;
  // diagrams.net stores compressed pages as base64(deflateRaw(encodeURIComponent(XML))).
  if(!/^[A-Za-z0-9+/=\s]+$/.test(encoded))throw Error('UNSUPPORTED_DRAWIO_PAGE');
  const decoded=inflateRawSync(Buffer.from(encoded.trim(),'base64'),{maxOutputLength:limit});
  const page=decodeURIComponent(new TextDecoder('utf-8',{fatal:true}).decode(decoded));
  const result=rewriteGoogleLinks(page,mapping);count+=result.count;
  return result.count?open+deflateRawSync(Buffer.from(encodeURIComponent(result.text))).toString('base64')+close:whole;
 });
 if(!count)return {data,count};
 let result=Buffer.from(output,le||be?'utf16le':'utf8');if(be)result=result.swap16();
 return {data:result,count};
}

/** Bounded archive rewrite. All non-XML parts, including embedded media, retain
 * their exact bytes. Unsupported binary formats are explicitly reported. */
export async function rewriteDocumentLinks(data:Buffer,format:string,mapping:LinkMap,options:{maxExpandedBytes?:number;maxEntries?:number}={}):Promise<LinkRewrite>{
 const limit=options.maxExpandedBytes??256*1024**2,maxEntries=options.maxEntries??10000;
 if(data.length>limit)throw Error('CONTENT_LIMIT');
 if(textFormats.has(format))return {...transformText(data,mapping,format==='drawio',limit,format==='csv'||format==='tsv'?format:undefined),supported:true};
 if(!archiveFormats.has(format))return {data,count:0,supported:false};
 const archive=await fromBufferPromise(data,{lazyEntries:true,autoClose:false,strictFileNames:true,validateEntrySizes:true});
 try{
  const parts:{name:string;data:Buffer;mtime:Date;mode:number;compress:boolean}[]=[];const names=new Set<string>();let total=0,count=0;
  for await(const entry of archive.eachEntry()){
   if(names.has(entry.fileName)||names.size>=maxEntries)throw Error('ARCHIVE_LIMIT');names.add(entry.fileName);
   if(entry.generalPurposeBitFlag&1)throw Error('ENCRYPTED_ARCHIVE');
   total+=entry.uncompressedSize;if(total>limit)throw Error('ARCHIVE_LIMIT');
   const chunks:Buffer[]=[];let size=0;
   for await(const chunk of await archive.openReadStreamPromise(entry)){size+=chunk.length;if(size>entry.uncompressedSize||size>limit)throw Error('ARCHIVE_LIMIT');chunks.push(Buffer.from(chunk));}
   const original=Buffer.concat(chunks);if(size!==entry.uncompressedSize||crc32(original)!==entry.crc32)throw Error('CORRUPT_ARCHIVE');
   const result=/\.(xml|rels|vml|svg|html|htm|xhtml)$/i.test(entry.fileName)?transformText(original,mapping):{data:original,count:0};count+=result.count;
   parts.push({name:entry.fileName,data:result.data,mtime:entry.getLastModDate(),mode:entry.externalFileAttributes>>>16,compress:entry.compressionMethod!==0});
  }
  if(!count)return {data,count,supported:true};
  if(parts.some(p=>p.name.startsWith('_xmlsignatures/')||/META-INF\/.*signatures/i.test(p.name)))throw Error('SIGNED_ARCHIVE');
  const writer=new ZipFile(),chunks:Buffer[]=[];
  const done=(async()=>{let size=0;for await(const chunk of writer.outputStream){size+=chunk.length;if(size>limit)throw Error('ARCHIVE_LIMIT');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);})();
  writer.on('error',(error:Error)=>(writer.outputStream as Readable).destroy(error));
  for(const part of parts){const metadata={mtime:part.mtime,mode:part.mode||0o100644,compress:part.compress};if(part.name.endsWith('/'))writer.addEmptyDirectory(part.name,metadata);else writer.addBuffer(part.data,part.name,metadata);}
  writer.end();return {data:await done,count,supported:true};
 }finally{archive.close();}
}
