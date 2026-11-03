import {ProviderError,type ProviderCheck} from './adapter.ts';
import type {GoogleAuthorization} from './credential-vault.ts';
import {GoogleReadHttp,googleFileId} from './google-read-http.ts';
import {GoogleMetadata,type GoogleFile} from './google-metadata.ts';
export type GoogleDiscoveredFile=Readonly<GoogleFile&{name:string}>;
export type GoogleDiscoveryPage=Readonly<{folderId:string;items:readonly GoogleDiscoveredFile[];nextPageToken:string|null}>;
function invalid():never{throw new ProviderError('PROVIDER_SOURCE_CHANGED');}
function cursor(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=16384&&!/[\x00-\x20\x7f]/.test(value)&&Buffer.from(value).toString('utf8')===value;}
function interrupt<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{if(signal.aborted){void work.catch(()=>{});return Promise.reject(new ProviderError('PROVIDER_CANCELLED'));}return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(new ProviderError('PROVIDER_CANCELLED'));};signal.addEventListener('abort',abort,{once:true});work.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});}
/** Worker-only inventory: never grants local rights, creates documents or infers deletion.
 * A page is not a consistent snapshot of every page, nor proof of source bytes/preview readiness. */
export class GoogleDiscoveryReader{
 private root:string;private http:GoogleReadHttp;private metadata:GoogleMetadata;private totalMs:number;private lifetime=new AbortController();private active=new Map<AbortController,Promise<void>>();private draining:Promise<void>|undefined;
 constructor(root:string,auth:GoogleAuthorization,managed:(id:string,options:ProviderCheck)=>Promise<readonly string[]>,options:{fetch?:typeof fetch;timeoutMs?:number;totalMs?:number}={}){
  this.root=googleFileId(root);this.totalMs=options.totalMs??30000;if(!Number.isSafeInteger(this.totalMs)||this.totalMs<1||this.totalMs>30000)throw new ProviderError('PROVIDER_CONFIG_CHANGED');this.http=new GoogleReadHttp(auth,options);this.metadata=new GoogleMetadata(this.http,managed);
 }
 async page(value:{folderId?:string;pageToken?:string},options:ProviderCheck):Promise<GoogleDiscoveryPage>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getOwnPropertySymbols(value).length)invalid();const input:Record<string,unknown>=Object.create(null);for(const name of Object.getOwnPropertyNames(value)){const field=Object.getOwnPropertyDescriptor(value,name);if(!['folderId','pageToken'].includes(name)||!field?.enumerable||!('value' in field))invalid();input[name]=field.value;}
  const folderId=googleFileId(input.folderId??this.root),pageToken=input.pageToken;if(pageToken!==undefined&&!cursor(pageToken))invalid();
  const parent=options.signal,authority=options.check;if(this.lifetime.signal.aborted||parent?.aborted)throw new ProviderError('PROVIDER_CANCELLED');if(this.active.size>=4)throw new ProviderError('PROVIDER_UNAVAILABLE');const deadline=new AbortController();let done!:()=>void;this.active.set(deadline,new Promise<void>(resolve=>done=resolve));const signal=AbortSignal.any([this.lifetime.signal,deadline.signal,...(parent?[parent]:[])]),timer=setTimeout(()=>deadline.abort(),this.totalMs);
  const check=async()=>{if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');await interrupt(Promise.resolve().then(()=>authority()),signal);if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');},scope={signal,check};
  try{
   await check();const before=await this.metadata.folder(folderId,this.root,scope),raw=await this.http.children(before.id,scope,pageToken as string|undefined);await check();
   if(raw.incompleteSearch!==undefined&&raw.incompleteSearch!==false)throw new ProviderError('PROVIDER_UNAVAILABLE');if(!Array.isArray(raw.files)||raw.files.length>100||raw.nextPageToken!==undefined&&raw.nextPageToken!==''&&!cursor(raw.nextPageToken))invalid();
   const items:GoogleDiscoveredFile[]=[],seen=new Set<string>();for(const value of raw.files){if(!value||typeof value!=='object'||Array.isArray(value))invalid();const named=value as Record<string,unknown>,id=googleFileId(named.id);if(seen.has(id)||typeof named.name!=='string'||!named.name||Buffer.byteLength(named.name)>4096||/[\x00-\x1f\x7f]/.test(named.name)||Buffer.from(named.name).toString('utf8')!==named.name)invalid();seen.add(id);const file=await this.metadata.listed(named,before.id,scope);items.push(Object.freeze({...file,name:named.name}));}
   const after=await this.metadata.folder(folderId,this.root,scope);await check();if(before.id!==after.id||before.version!==after.version||JSON.stringify(before.parents)!==JSON.stringify(after.parents))throw new ProviderError('PROVIDER_CONFLICT');
   return Object.freeze({folderId:before.id,items:Object.freeze(items),nextPageToken:typeof raw.nextPageToken==='string'&&raw.nextPageToken?raw.nextPageToken:null});
  }catch(error){if(this.lifetime.signal.aborted||parent?.aborted)throw new ProviderError('PROVIDER_CANCELLED');if(deadline.signal.aborted)throw new ProviderError('PROVIDER_UNAVAILABLE');throw error;}
  finally{clearTimeout(timer);deadline.abort();this.active.delete(deadline);done();}
 }
 close():Promise<void>{if(this.draining)return this.draining;this.lifetime.abort();this.draining=Promise.all([...this.active.values(),this.http.close()]).then(()=>{});return this.draining;}
}
