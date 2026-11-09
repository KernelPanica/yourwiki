import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {access,mkdtemp,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ProviderError,safeProviderError,type ProviderCheck,type ProviderReceipt,type ReplaceSource} from './adapter.ts';
import type {RemoteFile,RemoteStorage} from './remote-storage.ts';

const bridge=fileURLToPath(new URL('./network-transport.py',import.meta.url));
const maximum=4*1024**3,controlLimit=8*1024**2;
type NetworkProvider='sftp'|'smb';
type CreateSource=Omit<ReplaceSource,'baseline'>;

function reference(value:string,empty=false){
 if(typeof value!=='string'||value.length>4096||(!value&&!empty)||value&&value.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/[\\:*?"<>|\x00-\x1f]/.test(part)))throw new ProviderError('PROVIDER_INVALID_REFERENCE');
 return value;
}
function operation(value:string){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))throw new ProviderError('PROVIDER_INVALID_REFERENCE');return value;}
function receipt(value:any):ProviderReceipt{
 if(!value||typeof value.fingerprint!=='string'||value.fingerprint.length>2048||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest)||!Number.isSafeInteger(value.size)||value.size<0||value.size>maximum)throw new ProviderError('PROVIDER_UNAVAILABLE');
 return {fingerprint:value.fingerprint,digest:value.digest,size:value.size};
}
async function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');let abort!:()=>void;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{abort=()=>reject(new ProviderError('PROVIDER_CANCELLED'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener('abort',abort);}
}

/** Real network IO runs in a private, credential-isolated Python process.
 * Files spool to a mode-0700 local directory with fixed byte limits; the JS heap
 * never holds an entire remote file. Remote writes use optimistic conflict
 * detection and acknowledge only a complete download/hash after rename.
 */
class NetworkStorage implements RemoteStorage {
 private readonly shutdown=new AbortController();
 private readonly children=new Set<ChildProcessWithoutNullStreams>();
 private readonly pending=new Set<Promise<unknown>>();
 private provider:NetworkProvider;private config:Record<string,unknown>;private directory:string;private python:string;private limit:number;
 private constructor(provider:NetworkProvider,config:Record<string,unknown>,directory:string,python:string,limit:number){this.provider=provider;this.config=config;this.directory=directory;this.python=python;this.limit=limit;}
 static async open(provider:NetworkProvider,config:Record<string,unknown>,limit:number){
  if(!Number.isSafeInteger(limit)||limit<0||limit>maximum)throw new ProviderError('PROVIDER_EXPORT_LIMIT');
  let python=process.env.YOURWIKI_NETWORK_PYTHON;
  if(!python){try{await access('/opt/yourwiki-network/bin/python');python='/opt/yourwiki-network/bin/python';}catch{python='python3';}}
  let pinned:Record<string,unknown>;
  try{const serialized=JSON.stringify(config);if(serialized.length>128*1024)throw new Error();pinned=JSON.parse(serialized);if(!pinned||Array.isArray(pinned)||typeof pinned!=='object')throw new Error();}catch{throw new ProviderError('PROVIDER_INVALID_REFERENCE');}
  const directory=await mkdtemp(join(tmpdir(),'yourwiki-network-'));
  const storage=new NetworkStorage(provider,pinned,directory,python,limit);
  try{await storage.run({action:'probe'},{check:()=>{}});return storage;}catch(error){await storage.close();throw safeProviderError(error);}
 }
 private scope(scope:ProviderCheck):ProviderCheck{return {...scope,signal:scope.signal?AbortSignal.any([scope.signal,this.shutdown.signal]):this.shutdown.signal};}
 private async check(scope:ProviderCheck){if(this.shutdown.signal.aborted||scope.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');await abortable(Promise.resolve().then(()=>scope.check()),scope.signal??this.shutdown.signal);if(this.shutdown.signal.aborted||scope.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');}
 private track<T>(promise:Promise<T>):Promise<T>{this.pending.add(promise);return promise.finally(()=>this.pending.delete(promise));}
 private async run(request:Record<string,unknown>,options:ProviderCheck):Promise<unknown>{
  const scope=this.scope(options);await this.check(scope);
  const frame=JSON.stringify({...request,provider:this.provider,config:this.config,limit:this.limit});
  if(Buffer.byteLength(frame)>256*1024)throw new ProviderError('PROVIDER_INVALID_REFERENCE');
  return await new Promise((resolve,reject)=>{
   const child=spawn(this.python,['-I',bridge],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'C.UTF-8',PYTHONIOENCODING:'utf-8'}});
   this.children.add(child);let output='',total=0,finished=false,result:unknown,hasResult=false,authorized=false,writing=false,failed:ProviderError|undefined;
   const finish=(error?:ProviderError)=>{if(finished)return;finished=true;clearTimeout(timeout);scope.signal?.removeEventListener('abort',cancel);this.children.delete(child);child.kill('SIGKILL');error?reject(error):resolve(result);};
   const cancel=()=>finish(new ProviderError('PROVIDER_CANCELLED',writing?'unknown':'not_written'));
   const timeout=setTimeout(()=>finish(new ProviderError('PROVIDER_UNAVAILABLE',writing?'unknown':'not_written')),300_000);
   scope.signal?.addEventListener('abort',cancel,{once:true});if(scope.signal?.aborted){cancel();return;}
   child.on('error',()=>finish(new ProviderError('PROVIDER_UNAVAILABLE',writing?'unknown':'not_written')));
   child.stdin.on('error',()=>finish(new ProviderError('PROVIDER_UNAVAILABLE',writing?'unknown':'not_written')));
   // Discard stderr rather than risk propagating transport diagnostics/secrets.
   child.stderr.resume();
   child.stdout.setEncoding('utf8');
   child.stdout.on('data',(chunk:string)=>{
    total+=Buffer.byteLength(chunk);if(total>controlLimit){finish(new ProviderError('PROVIDER_EXPORT_LIMIT',writing?'unknown':'not_written'));return;}output+=chunk;
    while(!finished&&output.includes('\n')){
     const end=output.indexOf('\n'),line=output.slice(0,end);output=output.slice(end+1);let message:any;
     try{message=JSON.parse(line);}catch{finish(new ProviderError('PROVIDER_UNAVAILABLE',writing?'unknown':'not_written'));return;}
     if(message.ready===true){
      if(authorized||!['create','replace'].includes(String(request.action))){finish(new ProviderError('PROVIDER_UNAVAILABLE'));return;}authorized=true;
      void this.check(scope).then(()=>{if(!finished){writing=true;child.stdin.write('commit\n');}}).catch(error=>finish(safeProviderError(error)));
     }else if(typeof message.error==='string'){failed=new ProviderError(message.error,message.outcome==='unknown'?'unknown':'not_written');}
     else if(Object.hasOwn(message,'result')){result=message.result;hasResult=true;}
     else{finish(new ProviderError('PROVIDER_UNAVAILABLE',writing?'unknown':'not_written'));return;}
    }
   });
   child.on('close',code=>{if(finished)return;if(failed)finish(failed);else if(code!==0||!hasResult||output.trim())finish(new ProviderError('PROVIDER_UNAVAILABLE',writing?'unknown':'not_written'));else finish();});
   child.stdin.write(frame+'\n');
  });
 }
 list(value:string,options:ProviderCheck):Promise<RemoteFile[]>{return this.track(this.listing(value,options));}
 private async listing(value:string,options:ProviderCheck){
  const scope=this.scope(options);reference(value,true);
  try{const result=await this.run({action:'list',reference:value},scope);await this.check(scope);if(!Array.isArray(result)||result.length>10000)throw new ProviderError('PROVIDER_EXPORT_LIMIT');
   return result.map((item:any)=>{if(!item||typeof item.name!=='string'||item.name.includes('/')||!['file','folder'].includes(item.kind)||item.reference!==[value,item.name].filter(Boolean).join('/'))throw new ProviderError('PROVIDER_INVALID_REFERENCE');reference(item.name);reference(item.reference);if(item.kind==='file'&&(!Number.isSafeInteger(item.size)||item.size<0))throw new ProviderError('PROVIDER_UNAVAILABLE');return {reference:item.reference,name:item.name,kind:item.kind,...(item.kind==='file'?{size:item.size}:{})} as RemoteFile;});
  }catch(error){throw safeProviderError(error);}
 }
 read(value:string,options:ProviderCheck){return this.track(this.readFile(value,options));}
 private async readFile(value:string,options:ProviderCheck){
  const scope=this.scope(options);reference(value);const file=join(this.directory,randomUUID());
  try{const proof=receipt(await this.run({action:'read',reference:value,file},scope));await this.check(scope);const adapter=this;
   const bytes=(async function*(){const stream=createReadStream(file,{highWaterMark:65536}),hash=createHash('sha256');let size=0;try{for await(const chunk of stream){await adapter.check(scope);size+=chunk.length;if(size>proof.size)throw new ProviderError('PROVIDER_SOURCE_CHANGED');hash.update(chunk);yield chunk as Buffer;}await adapter.check(scope);if(size!==proof.size||hash.digest('hex')!==proof.digest)throw new ProviderError('PROVIDER_SOURCE_CHANGED');}catch(error){throw safeProviderError(error);}finally{stream.destroy();await rm(file,{force:true});}})();
   return {fingerprint:proof.fingerprint,size:proof.size,bytes};
  }catch(error){await rm(file,{force:true});throw safeProviderError(error);}
 }
 create(input:CreateSource):Promise<ProviderReceipt>{return this.track(this.write('create',input));}
 replace(input:ReplaceSource):Promise<ProviderReceipt>{return this.track(this.write('replace',input));}
 private async write(action:'create'|'replace',input:CreateSource|ReplaceSource):Promise<ProviderReceipt>{
  const scope=this.scope(input);reference(input.reference);operation(input.operationId);
  const target={...input.target};if(!Number.isSafeInteger(target.size)||target.size<0||target.size>this.limit||typeof target.digest!=='string'||!/^[a-f0-9]{64}$/.test(target.digest))throw new ProviderError('PROVIDER_SOURCE_CHANGED');
  const file=join(this.directory,randomUUID());let uncertain=false;
  try{
   await this.check(scope);const output=await open(file,'wx',0o600),hash=createHash('sha256');let size=0;
   try{const iterator=input.source[Symbol.asyncIterator]();try{while(true){const next=await abortable(Promise.resolve().then(()=>iterator.next()),scope.signal!);if(next.done)break;const chunk=next.value;if(!(chunk instanceof Uint8Array)||chunk.byteLength>target.size-size)throw new ProviderError('PROVIDER_SOURCE_CHANGED');for(let offset=0;offset<chunk.byteLength;offset+=65536){await this.check(scope);const part=chunk.subarray(offset,Math.min(chunk.byteLength,offset+65536));await output.writeFile(part);hash.update(part);size+=part.byteLength;}}}finally{void Promise.resolve().then(()=>iterator.return?.()).catch(()=>{});}if(size!==target.size||hash.digest('hex')!==target.digest)throw new ProviderError('PROVIDER_SOURCE_CHANGED');await output.sync();}finally{await output.close();}
   const result=receipt(await this.run({action,reference:input.reference,operationId:input.operationId,file,target,...(action==='replace'?{baseline:(input as ReplaceSource).baseline}:{})},scope));uncertain=true;
   if(result.size!==target.size||result.digest!==target.digest)throw new ProviderError('PROVIDER_CONFLICT','unknown');await this.check(scope);return result;
  }catch(error){throw safeProviderError(error,uncertain);}finally{await rm(file,{force:true});}
 }
 retire(input:{operationId:string;reference:string;signal?:AbortSignal}):Promise<void>{return this.track(this.retireFile(input));}
 private async retireFile(input:{operationId:string;reference:string;signal?:AbortSignal}){reference(input.reference);operation(input.operationId);try{await this.run({action:'retire',reference:input.reference,operationId:input.operationId},{signal:input.signal,check:()=>{}});}catch(error){throw safeProviderError(error);}}
 async close(){this.shutdown.abort();for(const child of this.children)child.kill('SIGKILL');await Promise.allSettled([...this.pending]);await rm(this.directory,{recursive:true,force:true});this.config={};}
}

export async function openNetworkStorage(provider:NetworkProvider,config:Record<string,unknown>,maxBytes=maximum):Promise<RemoteStorage>{
 if(provider!=='sftp'&&provider!=='smb')throw new ProviderError('PROVIDER_INVALID_REFERENCE');
 return NetworkStorage.open(provider,config,maxBytes);
}
