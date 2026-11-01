import {constants,type BigIntStats} from 'node:fs';
import {lstat,rename,unlink,type FileHandle} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ProviderError,safeProviderError,type ProviderAdapter,type ProviderCheck,type ReplaceSource,type ProviderReceipt} from './adapter.ts';
import {LocalPaths,localFileFlags} from './local-paths.ts';
const maxBytes=4*1024**3,chunkBytes=64*1024;
function identity(s:BigIntStats){return [s.dev,s.ino,s.mtimeNs,s.ctimeNs,s.size].map(x=>x.toString());}
function same(a:BigIntStats,b:BigIntStats){return identity(a).join(':')===identity(b).join(':');}
function operation(id:string){if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))throw new ProviderError('PROVIDER_INVALID_REFERENCE');return '.yourwiki-delivery-'+id;}
async function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');let abort!:()=>void;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{abort=()=>reject(new ProviderError('PROVIDER_CANCELLED'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener('abort',abort);}
}
async function* chunks(source:AsyncIterable<Uint8Array>,signal:AbortSignal){
 const iterator=source[Symbol.asyncIterator]();try{while(true){const next=await abortable(Promise.resolve().then(()=>iterator.next()),signal);if(next.done)return;yield next.value;}}finally{void Promise.resolve().then(()=>iterator.return?.()).catch(()=>{});}
}
/** Linux local binary originals. Optimistic conflict detection, not external-process CAS. */
export class LocalAdapter implements ProviderAdapter {
 private paths:LocalPaths;private shutdown=new AbortController();private writes=new Set<Promise<ProviderReceipt>>();
 private constructor(paths:LocalPaths){this.paths=paths;}
 static async open(root:string){try{return new LocalAdapter(await LocalPaths.open(root));}catch(error){throw safeProviderError(error);}}
 async close(){this.shutdown.abort();await Promise.allSettled([...this.writes]);await this.paths.close();}
 private async check(options:ProviderCheck){this.paths.assertOpen();if(options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');await abortable(Promise.resolve().then(()=>options.check()),options.signal?AbortSignal.any([this.shutdown.signal,options.signal]):this.shutdown.signal);this.paths.assertOpen();if(options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');}
 private async validFile(handle:FileHandle){const stat=await handle.stat({bigint:true});if(!stat.isFile()||stat.size>BigInt(maxBytes))throw new ProviderError('PROVIDER_SOURCE_CHANGED');return stat;}
 private async scan(handle:FileHandle,path:string,options:ProviderCheck){
  await this.check(options);const before=await this.validFile(handle),hash=createHash('sha256'),data=Buffer.allocUnsafe(chunkBytes);let position=0;
  while(position<Number(before.size)){await this.check(options);const read=await handle.read(data,0,Math.min(chunkBytes,Number(before.size)-position),position);if(!read.bytesRead)throw new ProviderError('PROVIDER_CONFLICT');hash.update(data.subarray(0,read.bytesRead));position+=read.bytesRead;}
  await this.check(options);const after=await handle.stat({bigint:true}),named=await lstat(path,{bigint:true});if(!same(before,after)||!same(after,named)||!named.isFile())throw new ProviderError('PROVIDER_CONFLICT');
  const digest=hash.digest('hex');return {stat:after,digest,size:position,fingerprint:JSON.stringify(['local-v1',...identity(after),digest])};
 }
 async read(reference:string,options:ProviderCheck){
  let parent:Awaited<ReturnType<LocalPaths['parent']>>|undefined,file:FileHandle|undefined;
  try{await this.check(options);parent=await this.paths.parent(reference);const path=`${parent.path}/${parent.name}`;file=await this.paths.own(path,localFileFlags);const proof=await this.scan(file,path,options),paths=this.paths,adapter=this,pinned=file,owner=parent;
   const bytes=(async function*(){try{const hash=createHash('sha256');let position=0;while(position<proof.size){await adapter.check(options);const data=Buffer.allocUnsafe(Math.min(chunkBytes,proof.size-position)),read=await pinned.read(data,0,data.length,position);if(!read.bytesRead)throw new ProviderError('PROVIDER_CONFLICT');position+=read.bytesRead;hash.update(data.subarray(0,read.bytesRead));yield data.subarray(0,read.bytesRead);}await adapter.check(options);if(hash.digest('hex')!==proof.digest||!same(proof.stat,await pinned.stat({bigint:true}))||!same(proof.stat,await lstat(path,{bigint:true})))throw new ProviderError('PROVIDER_CONFLICT');}catch(error){throw safeProviderError(error);}finally{await paths.release(pinned);await paths.release(owner.handle);}})();
   return {fingerprint:proof.fingerprint,size:proof.size,bytes};
  }catch(error){if(file)await this.paths.release(file);if(parent)await this.paths.release(parent.handle);throw safeProviderError(error);}
 }
 replace(input:ReplaceSource):Promise<ProviderReceipt>{
  const pinned={...input,target:{...input.target},signal:input.signal?AbortSignal.any([this.shutdown.signal,input.signal]):this.shutdown.signal};
  const pending=this.write(pinned);this.writes.add(pending);return pending.finally(()=>this.writes.delete(pending));
 }
 private async write(input:ReplaceSource):Promise<ProviderReceipt>{
  let parent:Awaited<ReturnType<LocalPaths['parent']>>|undefined,candidate:FileHandle|undefined,candidatePath:string|undefined,uncertain=false;
  try{
   const name=operation(input.operationId);if(!input.target||typeof input.target.digest!=='string'||!/^[a-f0-9]{64}$/.test(input.target.digest)||!Number.isSafeInteger(input.target.size)||input.target.size<0||input.target.size>maxBytes)throw new ProviderError('PROVIDER_SOURCE_CHANGED');
   await this.check(input);parent=await this.paths.parent(input.reference);const originalPath=`${parent.path}/${parent.name}`;
   const verifyBaseline=async()=>{const original=await this.paths.own(originalPath,localFileFlags);try{const proof=await this.scan(original,originalPath,input);if(proof.fingerprint!==input.baseline)throw new ProviderError('PROVIDER_CONFLICT');}finally{await this.paths.release(original);}};
   await verifyBaseline();candidatePath=`${parent.path}/${name}`;candidate=await this.paths.own(candidatePath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
   await this.check(input);const hash=createHash('sha256');let size=0;
   for await(const chunk of chunks(input.source,input.signal!)){if(!(chunk instanceof Uint8Array)||size+chunk.byteLength>input.target.size)throw new ProviderError('PROVIDER_SOURCE_CHANGED');for(let offset=0;offset<chunk.byteLength;){await this.check(input);const end=Math.min(chunk.byteLength,offset+chunkBytes),part=chunk.subarray(offset,end);let written=0;while(written<part.byteLength){await this.check(input);const result=await candidate.write(part,written,part.byteLength-written,size+written);if(!result.bytesWritten)throw new ProviderError('PROVIDER_UNAVAILABLE');written+=result.bytesWritten;}hash.update(part);size+=part.byteLength;offset=end;}}
   if(size!==input.target.size||hash.digest('hex')!==input.target.digest)throw new ProviderError('PROVIDER_SOURCE_CHANGED');await candidate.sync();await this.check(input);await verifyBaseline();await this.check(input);
   // Retiring this UUID path physically fences an owner suspended after its last lease check.
   uncertain=true;await rename(candidatePath,originalPath);await parent.handle.sync();
   const result=await this.paths.own(originalPath,localFileFlags);try{const proof=await this.scan(result,originalPath,input);if(proof.digest!==input.target.digest||proof.size!==input.target.size)throw new ProviderError('PROVIDER_CONFLICT','unknown');return {fingerprint:proof.fingerprint,digest:proof.digest,size:proof.size};}finally{await this.paths.release(result);}
  }catch(error){throw safeProviderError(error,uncertain);}finally{if(candidate)await this.paths.release(candidate);if(candidate&&candidatePath)try{await unlink(candidatePath);}catch{}if(parent)await this.paths.release(parent.handle);}
 }
 async retire(input:{operationId:string;reference:string;signal?:AbortSignal}):Promise<void>{
  let parent:Awaited<ReturnType<LocalPaths['parent']>>|undefined;
  try{const name=operation(input.operationId);if(input.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');parent=await this.paths.parent(input.reference);try{await unlink(`${parent.path}/${name}`);}catch(error){if((error as any)?.code!=='ENOENT')throw error;}await parent.handle.sync();}catch(error){throw safeProviderError(error);}finally{if(parent)await this.paths.release(parent.handle);}
 }
}
