import { sessionSnapshot,sessionGenerationIsCurrent } from './session-fence.ts';
export interface Account { features?: {googleConnect?:boolean;googleDiscovery?:boolean;googleImport?:boolean}; user: { id: string; username: string; displayName: string; adminRole: string; groups: {id:string;name:string}[] }; csrf: string }
export interface DocumentInfo { id: string; title: string; format: string; revision: number; manifestDigest: string; capabilities: {write:boolean;export:boolean;office?:boolean} }
export interface Artifact { name:string;digest:string;size:number;mimeType:string }
export interface DocumentView { sourceSync?:unknown; sourceSyncAction?:unknown; sourceDelivery?:unknown; document: DocumentInfo; manifest: {kind:string;primary:string;artifacts:Artifact[]}; presentation: unknown }
export class ApiError extends Error {
  code: string; requestId: string; operationId: string|null;
  constructor(code: string, requestId='', operationId:string|null=null) { super(code); this.code=code; this.requestId=requestId; this.operationId=operationId; }
}
export async function api<T>(url:string, init:RequestInit={}):Promise<T> {
  const fence=sessionSnapshot(),control=/^\/api\/(?:auth\/(?:login|logout|office-revoke|office-opening-cancel)|account)(?:[?#]|$)/.test(url);
  if(fence.blocked&&!control)throw new ApiError('SESSION_REQUIRED');
  const controller=new AbortController();
  const signals=control?[init.signal]:[init.signal,fence.signal];
  const abort=()=>controller.abort();
  for(const signal of signals){if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});}
  const check=()=>{if(!sessionGenerationIsCurrent(fence.generation))throw new ApiError('SESSION_REQUIRED');controller.signal.throwIfAborted();};
  try{
    const response=await fetch(url,{...init,signal:controller.signal,credentials:'same-origin',cache:'no-store',headers:{...init.headers}});check();
    if(!response.ok){
      let value:{code?:string;requestId?:string;operationId?:string}={};
      try{value=await response.json();}catch{/* Proxy/non-JSON error. */}check();
      throw new ApiError(value.code??(response.status===401?'SESSION_REQUIRED':'REQUEST_FAILED'),value.requestId,value.operationId);
    }
    const value=response.status===204?undefined as T:await response.json();check();return value;
  }catch(error){if(!sessionGenerationIsCurrent(fence.generation))throw new ApiError('SESSION_REQUIRED');throw error;}
  finally{for(const signal of signals)signal?.removeEventListener('abort',abort);}

}
export function assetUrl(view:DocumentView,name:string):string {
  if(!view.manifest.artifacts.some(item=>item.name===name))throw new ApiError('INVALID_PREVIEW');
  return `/api/documents/${encodeURIComponent(view.document.id)}/previews/${view.document.manifestDigest}/assets/${encodeURIComponent(name)}`;
}
export function isAborted(error:unknown) { return error instanceof Error && error.name==='AbortError'; }
