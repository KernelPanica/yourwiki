import {createHash} from 'node:crypto';
import {ProviderError,type ProviderCheck,type ProviderRead} from './adapter.ts';
import type {GoogleAuthorization} from './credential-vault.ts';
import {GoogleReadHttp,googleFileId} from './google-read-http.ts';
import {GoogleContentHttp,googleExportTypes,googleExportMaxBytes} from './google-content-http.ts';
import {GoogleMetadata,type GoogleFile} from './google-metadata.ts';
export type GoogleReaderOptions={fetch?:typeof fetch;timeoutMs?:number;totalMs?:number;acceptMime?:(mime:string)=>boolean;format?:string;binaryOnly?:boolean};
type Managed=(reference:string,options:ProviderCheck)=>Promise<readonly string[]>;
export function googleSourceFingerprint(file:GoogleFile){
 if(file.kind==='binary')return JSON.stringify(['google-binary-v2',file.id,file.version,createHash('sha256').update(JSON.stringify([file.mimeType,file.size,file.parents,file.md5,file.sha256,file.headRevision])).digest('hex')]);
 if(file.kind==='folder')throw new ProviderError('PROVIDER_SOURCE_CHANGED');return JSON.stringify(['google-native-v1',file.id,file.version,createHash('sha256').update(JSON.stringify([file.mimeType,file.parents,googleExportTypes[file.kind]])).digest('hex')]);
}
async function* zipBytes(source:AsyncIterable<Uint8Array>){
 const header=new Uint8Array(4);let filled=0,size=0;
 for await(const chunk of source){size+=chunk.byteLength;if(filled===4){yield chunk;continue;}const take=Math.min(4-filled,chunk.byteLength);header.set(chunk.subarray(0,take),filled);filled+=take;if(filled<4)continue;
  if(header[0]!==0x50||header[1]!==0x4b||header[2]!==3||header[3]!==4)throw new ProviderError('PROVIDER_SOURCE_CHANGED');yield header;if(chunk.byteLength>take)yield chunk.subarray(take);
 }
 if(filled<4||size<22)throw new ProviderError('PROVIDER_SOURCE_CHANGED');
}
/** Worker-only verified source reader; native bytes remain lazy until the inbox reserves its cap. */
export class GoogleSourceReader{
 private root:string;private metadataHttp:GoogleReadHttp;private content:GoogleContentHttp;private metadata:GoogleMetadata;private shutdown=new AbortController();private draining:Promise<void>|undefined;private options:GoogleReaderOptions;
 constructor(root:string,auth:GoogleAuthorization,managed:Managed,options:GoogleReaderOptions={}){
  this.root=googleFileId(root);this.options={...options};this.metadataHttp=new GoogleReadHttp(auth,options);this.content=new GoogleContentHttp(auth,options);this.metadata=new GoogleMetadata(this.metadataHttp,managed);
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
 private validate(file:GoogleFile){
  if(file.kind==='binary'){if(file.size===null||!file.sha256&&!file.md5||this.options.acceptMime&&!this.options.acceptMime(file.mimeType))throw new ProviderError('PROVIDER_SOURCE_CHANGED');return;}
  if(this.options.binaryOnly||file.kind==='folder'||this.options.format!==googleExportTypes[file.kind].format)throw new ProviderError('PROVIDER_SOURCE_CHANGED');
 }
 async changed(reference:string,baseline:string,options:ProviderCheck):Promise<boolean>{
  googleFileId(reference);const scope=this.scope(options),file=await this.metadata.verify(reference,this.root,scope);await scope.check();this.validate(file);return googleSourceFingerprint(file)!==baseline;
 }
 async read(reference:string,options:ProviderCheck):Promise<ProviderRead>{
  googleFileId(reference);const scope=this.scope(options),before=await this.metadata.verify(reference,this.root,scope);await scope.check();this.validate(before);const pinned=googleSourceFingerprint(before),self=this;let used=false;
  const bytes:AsyncIterable<Uint8Array>={[Symbol.asyncIterator](){
   if(used)throw new ProviderError('PROVIDER_SOURCE_CHANGED');used=true;
   return (async function*(){
    await scope.check();if(before.kind==='binary'){
     const algorithm=before.sha256?'sha256':'md5',expected=before.sha256??before.md5!;let hash;try{hash=createHash(algorithm);}catch{throw new ProviderError('PROVIDER_UNAVAILABLE');}
     for await(const chunk of self.content.binary(reference,before.size!,scope)){hash.update(chunk);yield chunk;}if(hash.digest('hex')!==expected)throw new ProviderError('PROVIDER_CONFLICT');
    }else{
     if(before.kind==='folder')throw new ProviderError('PROVIDER_SOURCE_CHANGED');for await(const chunk of zipBytes(self.content.export(reference,before.kind,scope)))yield chunk;
    }
    await scope.check();const after=await self.metadata.verify(reference,self.root,scope);await scope.check();if(googleSourceFingerprint(after)!==pinned)throw new ProviderError('PROVIDER_CONFLICT');
   })();
  }};
  return before.kind==='binary'?{fingerprint:pinned,size:before.size!,bytes}:{fingerprint:pinned,size:null,maxSize:googleExportMaxBytes,bytes};
 }
 close():Promise<void>{if(this.draining)return this.draining;this.shutdown.abort();this.draining=Promise.all([this.content.close(),this.metadataHttp.close()]).then(()=>{});return this.draining;}
}
