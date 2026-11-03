import {createHash} from 'node:crypto';
import {ProviderError,type ProviderCheck} from './adapter.ts';
import type {GoogleAuthorization} from './credential-vault.ts';
import {GoogleReadHttp,googleFileId} from './google-read-http.ts';
import {GoogleContentHttp} from './google-content-http.ts';
import {GoogleMetadata,type GoogleFile} from './google-metadata.ts';
type Options={fetch?:typeof fetch;timeoutMs?:number;totalMs?:number;acceptMime?:(mime:string)=>boolean};
type Managed=(reference:string,options:ProviderCheck)=>Promise<readonly string[]>;
function fingerprint(file:GoogleFile){return JSON.stringify(['google-binary-v2',file.id,file.version,createHash('sha256').update(JSON.stringify([file.mimeType,file.size,file.parents,file.md5,file.sha256,file.headRevision])).digest('hex')]);}
/** Internal binary read composition, not a native export/write adapter. Trusted worker wiring
 * must supply the root from the pinned connection, borrowed auth and scoped grant lookup. */
export class GoogleBinaryReader{
 private acceptMime:((mime:string)=>boolean)|undefined;private root:string;private metadataHttp:GoogleReadHttp;private content:GoogleContentHttp;private metadata:GoogleMetadata;private shutdown=new AbortController();private draining:Promise<void>|undefined;
 constructor(root:string,auth:GoogleAuthorization,managed:Managed,options:Options={}){
  this.acceptMime=options.acceptMime;this.root=googleFileId(root);this.metadataHttp=new GoogleReadHttp(auth,options);this.content=new GoogleContentHttp(auth,options);this.metadata=new GoogleMetadata(this.metadataHttp,managed);
 }
 private scope(options:ProviderCheck):ProviderCheck{
  const signal=options.signal?AbortSignal.any([this.shutdown.signal,options.signal]):this.shutdown.signal;
  return {signal,check:async()=>{
   if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');const pending=Promise.resolve().then(()=>options.check());
   await new Promise<void>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(new ProviderError('PROVIDER_CANCELLED'));};signal.addEventListener('abort',abort,{once:true});
    pending.then(()=>{signal.removeEventListener('abort',abort);resolve();},error=>{signal.removeEventListener('abort',abort);reject(error);});if(signal.aborted)abort();
   });
   if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');
  }};
 }
 async read(reference:string,options:ProviderCheck):Promise<{fingerprint:string;size:number;bytes:AsyncIterable<Uint8Array>}>{
  googleFileId(reference);const scope=this.scope(options),before=await this.metadata.verify(reference,this.root,scope);await scope.check();
  if(before.kind!=='binary'||before.size===null||!before.sha256&&!before.md5||this.acceptMime&&!this.acceptMime(before.mimeType))throw new ProviderError('PROVIDER_SOURCE_CHANGED');const pinned=fingerprint(before),self=this;let used=false;
  return {fingerprint:pinned,size:before.size,bytes:{[Symbol.asyncIterator](){
   if(used)throw new ProviderError('PROVIDER_SOURCE_CHANGED');used=true;
   return (async function*(){
    await scope.check();const algorithm=before.sha256?'sha256':'md5',expected=before.sha256??before.md5!;let hash;try{hash=createHash(algorithm);}catch{throw new ProviderError('PROVIDER_UNAVAILABLE');}
    for await(const chunk of self.content.binary(reference,before.size!,scope)){hash.update(chunk);yield chunk;}
    if(hash.digest('hex')!==expected)throw new ProviderError('PROVIDER_CONFLICT');
    await scope.check();const after=await self.metadata.verify(reference,self.root,scope);await scope.check();
    if(after.kind!=='binary'||fingerprint(after)!==pinned)throw new ProviderError('PROVIDER_CONFLICT');
   })();
  }}};
 }
 close():Promise<void>{if(this.draining)return this.draining;this.shutdown.abort();this.draining=Promise.all([this.content.close(),this.metadataHttp.close()]).then(()=>{});return this.draining;}
}
