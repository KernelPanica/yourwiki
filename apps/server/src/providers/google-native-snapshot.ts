import {ProviderError,type ProviderCheck} from './adapter.ts';
import type {CredentialVault,AdapterConnection} from './credential-vault.ts';
import {GoogleReadHttp} from './google-read-http.ts';
import {GoogleMetadata} from './google-metadata.ts';
import {googleSourceFingerprint} from './google-reader.ts';
import {GoogleNativeRead,type GoogleNativeData,type GoogleNativeKind} from './google-native-read.ts';
export type GoogleNativeSnapshot=Readonly<GoogleNativeData&{baseline:string}>;
const snapshots=new WeakMap<object,{check:()=>Promise<void>}>();
/** A captured view is not write permission or proof that an exported file has equal semantics. */
export async function assertGoogleNativeSnapshot(value:unknown,expected:{kind:GoogleNativeKind;reference:string;baseline:string}):Promise<GoogleNativeSnapshot>{
 const entry=value&&typeof value==='object'?snapshots.get(value):undefined,snapshot=value as GoogleNativeSnapshot;
 if(!entry||snapshot.kind!==expected.kind||snapshot.reference!==expected.reference||snapshot.baseline!==expected.baseline)throw new ProviderError('PROVIDER_SOURCE_CHANGED');await entry.check();return snapshot;
}
function interrupt<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{if(signal.aborted){void work.catch(()=>{});return Promise.reject(new ProviderError('PROVIDER_CANCELLED'));}return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(new ProviderError('PROVIDER_CANCELLED'));};signal.addEventListener('abort',abort,{once:true});work.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});}
/** Worker-only canonical source snapshot. All native content stays private until a compiler/DTO validates it. */
export function createGoogleNativeSnapshotReader(vault:CredentialVault,connection:AdapterConnection,options:{fetch?:typeof fetch;timeoutMs?:number;totalMs?:number;maxBytes?:number}={}){
 const settings={...options},source=vault.googleSource(connection),kind:GoogleNativeKind=source.format==='docx'?'document':'presentation';if(!['docx','pptx'].includes(source.format))throw new ProviderError('PROVIDER_SOURCE_CHANGED');const totalMs=settings.totalMs??30000;if(!Number.isSafeInteger(totalMs)||totalMs<1||totalMs>30000)throw new ProviderError('PROVIDER_CONFIG_CHANGED');
 const auth=vault.google(connection),drive=new GoogleReadHttp(auth,settings),metadata=new GoogleMetadata(drive,vault.googleRecipients(connection)),native=new GoogleNativeRead(auth,settings),lifetime=new AbortController(),active=new Map<AbortController,Promise<void>>();let closed=false,draining:Promise<void>|undefined;
 return Object.freeze({
  read:async(options:ProviderCheck):Promise<GoogleNativeSnapshot>=>{
   const parent=options.signal,authority=options.check;if(closed||parent?.aborted)throw new ProviderError('PROVIDER_CANCELLED');if(active.size>=4)throw new ProviderError('PROVIDER_UNAVAILABLE');const deadline=new AbortController();let done!:()=>void;active.set(deadline,new Promise<void>(resolve=>done=resolve));const baseSignal=parent?AbortSignal.any([parent,lifetime.signal]):lifetime.signal,signal=AbortSignal.any([baseSignal,deadline.signal]),timer=setTimeout(()=>deadline.abort(),totalMs);
   const checkBase=async()=>{if(baseSignal.aborted)throw new ProviderError('PROVIDER_CANCELLED');source.checkBaseline();await interrupt(Promise.resolve().then(()=>authority()),baseSignal);source.checkBaseline();if(baseSignal.aborted)throw new ProviderError('PROVIDER_CANCELLED');};
   const check=async()=>{if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');await interrupt(checkBase(),signal);if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');};
   try{
    await check();const before=await metadata.verify(source.reference,source.root,{signal,check});await check();if(before.kind!==kind)throw new ProviderError('PROVIDER_SOURCE_CHANGED');if(googleSourceFingerprint(before)!==source.fingerprint)throw new ProviderError('PROVIDER_CONFLICT');
    const result=await native.read(kind,source.reference,{signal,check});await check();const after=await metadata.verify(source.reference,source.root,{signal,check});await check();if(googleSourceFingerprint(after)!==source.fingerprint)throw new ProviderError('PROVIDER_CONFLICT');
    const snapshot=Object.freeze({...result,baseline:source.fingerprint});snapshots.set(snapshot,{check:checkBase});return snapshot;
   }catch(error){if(baseSignal.aborted)throw new ProviderError('PROVIDER_CANCELLED');if(deadline.signal.aborted)throw new ProviderError('PROVIDER_UNAVAILABLE');throw error;}
   finally{clearTimeout(timer);deadline.abort();active.delete(deadline);done();}
  },
  close:():Promise<void>=>{if(draining)return draining;closed=true;lifetime.abort();for(const controller of active.keys())controller.abort();draining=Promise.all([...active.values(),drive.close(),native.close()]).then(()=>{});return draining;}
 });
}
