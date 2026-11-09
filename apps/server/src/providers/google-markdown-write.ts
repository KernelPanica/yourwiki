import {Readable} from 'node:stream';
import {sameGoogleBinaryContent} from './google-binary-baseline.ts';
import {createHash} from 'node:crypto';
import {ProviderError,safeProviderError,type ProviderAdapter,type ProviderCheck,type ReplaceSource} from './adapter.ts';
import type {GoogleAuthorization,CredentialVault,AdapterConnection} from './credential-vault.ts';
import {CloudHttp} from './cloud-storage-http.ts';
import {GoogleReadHttp,googleFileId} from './google-read-http.ts';
import {GoogleMetadata,type GoogleFile} from './google-metadata.ts';
import {GoogleContentHttp} from './google-content-http.ts';
import {GoogleBinaryReader} from './google-binary-reader.ts';
import {googleSourceFingerprint} from './google-reader.ts';
const formats=['md','markdown'];
function rcloneWritable(value:string){try{const x=JSON.parse(value);return Array.isArray(x)&&x.length===5&&x[0]==='rclone-drive-v1'&&typeof x[1]==='string'&&/^\d+$/.test(x[2])&&/^[a-f0-9]{32}$/.test(x[3])&&Number.isFinite(Date.parse(x[4]));}catch{return false;}}
const binaryMimes:Record<string,readonly string[]>={
 md:['text/markdown','text/x-markdown','text/plain'],markdown:['text/markdown','text/x-markdown','text/plain'],
 docx:['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],xlsx:['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],pptx:['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
 doc:['application/msword'],xls:['application/vnd.ms-excel'],ppt:['application/vnd.ms-powerpoint'],
 odt:['application/vnd.oasis.opendocument.text'],ods:['application/vnd.oasis.opendocument.spreadsheet'],odp:['application/vnd.oasis.opendocument.presentation'],odg:['application/vnd.oasis.opendocument.graphics'],
 rtf:['application/rtf','text/rtf'],txt:['text/plain'],csv:['text/csv','application/csv','text/plain'],tsv:['text/tab-separated-values','text/plain'],
 docm:['application/vnd.ms-word.document.macroenabled.12'],xlsm:['application/vnd.ms-excel.sheet.macroenabled.12'],pptm:['application/vnd.ms-powerpoint.presentation.macroenabled.12'],
 canvas:['application/json','text/plain'],drawio:['application/xml','text/xml','application/vnd.jgraph.mxfile','text/plain']
};
export function supportsGoogleBinary(format:string,fingerprint:string){if(rcloneWritable(fingerprint))return Object.hasOwn(binaryMimes,format);try{const v=JSON.parse(fingerprint);return Object.hasOwn(binaryMimes,format)&&Array.isArray(v)&&v.length===4&&v[0]==='google-binary-v2'&&typeof v[1]==='string'&&typeof v[2]==='string'&&typeof v[3]==='string';}catch{return false;}}

export function supportsGoogleMarkdown(format:string,fingerprint:string){if(rcloneWritable(fingerprint))return formats.includes(format);try{const value=JSON.parse(fingerprint);return formats.includes(format)&&Array.isArray(value)&&value.length===4&&value[0]==='google-binary-v2'&&typeof value[1]==='string'&&typeof value[2]==='string'&&typeof value[3]==='string';}catch{return false;}}
/** Binary originals only (never native Google objects). v2 supplies a strong ETag and enforces If-Match on the
 * same original. v3 metadata and byte readback retain the existing source proof. */
export class GoogleMarkdownAdapter implements ProviderAdapter{
 private format:string;private root:string;private auth:GoogleAuthorization;private http:CloudHttp;private metadataHttp:GoogleReadHttp;private metadata:GoogleMetadata;private reader:GoogleBinaryReader;private content:GoogleContentHttp;
 constructor(root:string,auth:GoogleAuthorization,managed:(ref:string,scope:ProviderCheck)=>Promise<readonly string[]>,options:{format?:string;fetch?:typeof fetch;timeoutMs?:number;totalMs?:number}={}){this.format=options.format??'md';this.root=googleFileId(root);this.auth=auth;this.http=new CloudHttp(options.fetch);this.metadataHttp=new GoogleReadHttp(auth,options);this.metadata=new GoogleMetadata(this.metadataHttp,managed,{allowExistingShares:true});this.reader=new GoogleBinaryReader(root,auth,managed,{...options,allowExistingShares:true});this.content=new GoogleContentHttp(auth,options);}
 read(reference:string,scope:ProviderCheck){return this.reader.read(reference,scope);}
 changed(reference:string,baseline:string,scope:ProviderCheck){return this.reader.changed(reference,baseline,scope);}
 async retire(input:{reference:string;operationId:string;signal?:AbortSignal}){googleFileId(input.reference);if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.operationId))throw new ProviderError('PROVIDER_INVALID_REFERENCE');await this.http.check({...input,check(){}});/* No temporary remote object and never a replay. */}
 private async request(path:string,scope:ProviderCheck,init:RequestInit={}){await this.http.check(scope);const token=await this.auth.access(scope);await this.http.check(scope);if(typeof token!=='string'||!token||/[^\x21-\x7e]/.test(token))throw new ProviderError('PROVIDER_CONFIG_CHANGED');const response=await this.http.request('https://www.googleapis.com/'+path,{...init,headers:{authorization:'Bearer '+token,...init.headers},cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'},scope,['www.googleapis.com']);if(response.status===401)this.auth.invalidate(token);return response;}
 async replace(input:ReplaceSource){let dispatched=false;try{
  googleFileId(input.reference);if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.operationId))throw new ProviderError('PROVIDER_INVALID_REFERENCE');
  let before!:GoogleFile,proof!:Record<string,unknown>;for(let attempt=0;;attempt++){
  before=await this.metadata.verify(input.reference,this.root,input,true);
  if(before.kind!=='binary'||!Object.hasOwn(binaryMimes,this.format)||before.mimeType!=='application/octet-stream'&&!binaryMimes[this.format].includes(before.mimeType))throw new ProviderError('SOURCE_SAVE_UNSUPPORTED');
  if(googleSourceFingerprint(before)!==input.baseline&&(!(before.headRevision||before.sha256)||!sameGoogleBinaryContent(googleSourceFingerprint(before),input.baseline)))throw new ProviderError('PROVIDER_CONFLICT');
  const proofResponse=await this.request('drive/v2/files/'+input.reference+'?fields=id,etag,version,md5Checksum,fileSize,headRevisionId',input);try{this.http.status(proofResponse);}catch(e){void proofResponse.body?.cancel();throw e;}proof=await this.http.json(proofResponse,input);
  if(typeof proof.etag!=='string'||proof.etag.length>4096||!/^"[^"\x00-\x20\x7f]+"$/.test(proof.etag))throw new ProviderError('SOURCE_SAVE_UNSUPPORTED');
  const sameContent=proof.id===before.id&&proof.fileSize===String(before.size)&&!!before.md5&&proof.md5Checksum===before.md5&&proof.headRevisionId===before.headRevision;
  if(!sameContent||proof.version!==before.version){if(sameContent&&attempt<2)continue;throw new ProviderError('PROVIDER_CONFLICT');}
  break;
  }
  if(!Number.isSafeInteger(input.target.size)||input.target.size<0||input.target.size>4*1024**3||!/^[a-f0-9]{64}$/.test(input.target.digest))throw new ProviderError('PROVIDER_EXPORT_LIMIT');
  const self=this;let streamed=0;const hash=createHash('sha256');
  // Bounded streaming keeps Office uploads out of the provider worker's 128 MB heap.
  // DeliveryWorker authenticates the immutable source before dispatch; verify it again in transit.
  const stream=Readable.from((async function*(){for await(const chunk of input.source){await self.http.check(input);if(!(chunk instanceof Uint8Array)||streamed+chunk.length>input.target.size)throw new ProviderError('PROVIDER_SOURCE_CHANGED');streamed+=chunk.length;hash.update(chunk);yield chunk;}if(streamed!==input.target.size||hash.digest('hex')!==input.target.digest)throw new ProviderError('PROVIDER_SOURCE_CHANGED');})());
  await this.http.check(input);dispatched=true;let response:Response;try{response=await this.request('upload/drive/v2/files/'+input.reference+'?uploadType=media&newRevision=true&fields=id,version',input,{method:'PUT',headers:{'if-match':proof.etag,'content-type':before.mimeType,'content-length':String(input.target.size)},body:Readable.toWeb(stream),duplex:'half'} as RequestInit); }finally{stream.destroy();}
  if(response.status!==200){if([400,401,403,404,409,412,429].includes(response.status))dispatched=false;void response.body?.cancel();this.http.status(response);throw new ProviderError('PROVIDER_UNKNOWN','unknown');}
  const receipt=await this.http.json(response,input);if(receipt.id!==before.id||typeof receipt.version!=='string')throw new ProviderError('PROVIDER_UNKNOWN','unknown');
  // Authenticate the actual saved bytes first, then bind them to fresh owned,
  // in-root metadata. A metadata-only version bump during GET is harmless;
  // a changed checksum, size, MIME or ownership remains an uncertain conflict.
  const digest=createHash('sha256'),md5=createHash('md5');let size=0;
  for await(const part of this.content.binary(input.reference,input.target.size,input)){await this.http.check(input);size+=part.byteLength;digest.update(part);md5.update(part);}
  const actual=digest.digest('hex'),actualMd5=md5.digest('hex');if(actual!==input.target.digest||size!==input.target.size)throw new ProviderError('PROVIDER_CONFLICT','unknown');
  const after=await this.metadata.verify(input.reference,this.root,input);await this.http.check(input);
  if(after.kind!=='binary'||after.size!==size||after.mimeType!==before.mimeType||(after.sha256?after.sha256!==actual:!after.md5||after.md5!==actualMd5||after.version!==receipt.version))throw new ProviderError('PROVIDER_CONFLICT','unknown');
  return {fingerprint:googleSourceFingerprint(after),digest:actual,size};
 }catch(e){throw safeProviderError(e,dispatched);}}
 async close(){this.http.close();await Promise.all([this.metadataHttp.close(),this.reader.close(),this.content.close()]);}
}
export function createGoogleMarkdownAdapter(vault:CredentialVault,connection:AdapterConnection,options:{fetch?:typeof fetch;timeoutMs?:number;totalMs?:number}={}){
 const authority=vault.googleWriteAuthority(connection),source=vault.googleSource(connection);if(!supportsGoogleBinary(source.format,source.fingerprint))throw new ProviderError('SOURCE_SAVE_UNSUPPORTED');
 const adapter=new GoogleMarkdownAdapter(source.root,vault.google(connection),vault.googleRecipients(connection),{...options,format:source.format});
 const scope=(input:ProviderCheck)=>({...input,check:async()=>{authority.check();source.checkBaseline();await input.check();authority.check();source.checkBaseline();}});
 return {read:(ref:string,input:ProviderCheck)=>{if(ref!==source.reference)throw new ProviderError('PROVIDER_INVALID_REFERENCE');return adapter.read(ref,scope(input));},replace:(input:ReplaceSource)=>{if(input.operationId!==authority.operationId||input.reference!==source.reference)throw new ProviderError('PROVIDER_INVALID_REFERENCE');return adapter.replace({...input,...scope(input)});},retire:(input:{reference:string;operationId:string;signal?:AbortSignal})=>{authority.check();source.checkBaseline();if(input.operationId!==authority.operationId||input.reference!==source.reference)throw new ProviderError('PROVIDER_INVALID_REFERENCE');return adapter.retire(input);},close:()=>adapter.close()};
}
