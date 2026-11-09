import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {ProviderError,type ProviderCheck,type ProviderRead,type ProviderReceipt,type ReplaceSource} from '../providers/adapter.ts';
import type {RemoteStorage} from '../providers/remote-storage.ts';

const partBytes=8*1024**2,prefix='ywbackup-parts-v1:';
type Part={reference:string;digest:string;size:number};
type Index={version:1;size:number;digest:string;previous:string|null;parts:Part[]};
const digest=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const invalid=()=>new ProviderError('PROVIDER_SOURCE_CHANGED');
/** Immutable encrypted parts keep provider requests and memory bounded, independently of archive size. */
export async function uploadBackup(storage:RemoteStorage,input:Omit<ReplaceSource,'baseline'>):Promise<ProviderReceipt>{
 if(!Number.isSafeInteger(input.target.size)||input.target.size<0)throw invalid();
 let size=0,number=0,indexNumber=0,previous:string|null=null,parts:Part[]=[],buffer=Buffer.allocUnsafe(partBytes),used=0;
 const hash=createHash('sha256');
 async function put(reference:string,data:Buffer){await input.check();const target={size:data.length,digest:digest(data)},receipt=await storage.create({...input,reference,target,source:Readable.from([data])});if(receipt.size!==target.size||receipt.digest!==target.digest)throw invalid();return {reference:receipt.reference??reference,...target};}
 async function index(){const data:Index={version:1,size:input.target.size,digest:input.target.digest,previous,parts};const receipt=await put(input.reference+'.index-'+String(indexNumber++).padStart(6,'0'),Buffer.from(JSON.stringify(data)));previous=receipt.reference;parts=[];return receipt;}
 async function part(data:Buffer){const receipt=await put(input.reference+'.part-'+String(number++).padStart(6,'0'),data);parts.push(receipt);if(parts.length===1000)await index();}
 for await(const value of input.source){await input.check();if(input.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');size+=value.length;if(!Number.isSafeInteger(size)||size>input.target.size)throw invalid();hash.update(value);let offset=0;while(offset<value.length){const length=Math.min(partBytes-used,value.length-offset);buffer.set(value.subarray(offset,offset+length),used);offset+=length;used+=length;if(used===partBytes){await part(buffer);buffer=Buffer.allocUnsafe(partBytes);used=0;}}}
 if(size!==input.target.size||hash.digest('hex')!==input.target.digest)throw invalid();
 if(used)await part(buffer.subarray(0,used));
 const receipt=await index();await input.check();return {...input.target,reference:prefix+receipt.reference,fingerprint:receipt.digest};
}
export async function readBackup(storage:RemoteStorage,reference:string,scope:ProviderCheck):Promise<ProviderRead>{
 if(!reference.startsWith(prefix))return storage.read(reference,scope); // Existing single-object archives remain readable.
 const pages:Index[]=[],seen=new Set<string>();let current:string|null=reference.slice(prefix.length);
 while(current!==null){await scope.check();if(!current||seen.has(current))throw invalid();seen.add(current);const remote=await storage.read(current,scope),chunks:Uint8Array[]=[];let size=0;for await(const chunk of remote.bytes){size+=chunk.length;if(size>partBytes)throw invalid();chunks.push(chunk);}let value:Index;try{value=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch{throw invalid();}
 if(!value||value.version!==1||!Number.isSafeInteger(value.size)||value.size<0||! /^[a-f0-9]{64}$/.test(value.digest)||!(value.previous===null||typeof value.previous==='string')||!Array.isArray(value.parts)||value.parts.length>1000||value.parts.some(p=>!p||typeof p.reference!=='string'||!p.reference||!Number.isSafeInteger(p.size)||p.size<0||p.size>partBytes||! /^[a-f0-9]{64}$/.test(p.digest)))throw invalid();
 if(pages.length&&(value.size!==pages[0].size||value.digest!==pages[0].digest))throw invalid();pages.push(value);current=value.previous;
 }
 if(!pages.length)throw invalid();const target=pages[0];
 return {size:target.size,fingerprint:target.digest,bytes:(async function*(){const hash=createHash('sha256');let total=0;for(const page of pages.reverse())for(const part of page.parts){await scope.check();const remote=await storage.read(part.reference,scope),partHash=createHash('sha256');let size=0;for await(const chunk of remote.bytes){await scope.check();size+=chunk.length;total+=chunk.length;if(size>part.size||total>target.size)throw invalid();partHash.update(chunk);hash.update(chunk);yield chunk;}if(size!==part.size||partHash.digest('hex')!==part.digest)throw invalid();}if(total!==target.size||hash.digest('hex')!==target.digest)throw invalid();await scope.check();})()};
}
