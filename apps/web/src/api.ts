export interface Account { user: { id: string; username: string; displayName: string; adminRole: string; groups: {id:string;name:string}[] }; csrf: string }
export interface DocumentInfo { id: string; title: string; format: string; revision: number; manifestDigest: string; capabilities: {write:boolean;export:boolean} }
export interface Artifact { name:string;digest:string;size:number;mimeType:string }
export interface DocumentView { document: DocumentInfo; manifest: {kind:string;primary:string;artifacts:Artifact[]}; presentation: unknown }
export class ApiError extends Error {
  code: string; requestId: string;
  constructor(code: string, requestId='') { super(code); this.code=code; this.requestId=requestId; }
}
export async function api<T>(url:string, init:RequestInit={}):Promise<T> {
  const response = await fetch(url,{...init, credentials:'same-origin',cache:'no-store',headers:{...init.headers}});
  init.signal?.throwIfAborted();
  if (!response.ok) {
    let value: {code?:string;requestId?:string} = {};
    try { value=await response.json(); } catch { /* proxy/non-JSON error */ }
    init.signal?.throwIfAborted();
    throw new ApiError(value.code ?? (response.status===401?'SESSION_REQUIRED':'REQUEST_FAILED'), value.requestId);
  }
  const value=response.status===204 ? undefined as T : await response.json();
  init.signal?.throwIfAborted();
  return value;
}
export function assetUrl(view:DocumentView,name:string):string {
  if(!view.manifest.artifacts.some(item=>item.name===name))throw new ApiError('INVALID_PREVIEW');
  return `/api/documents/${encodeURIComponent(view.document.id)}/previews/${view.document.manifestDigest}/assets/${encodeURIComponent(name)}`;
}
export function isAborted(error:unknown) { return error instanceof Error && error.name==='AbortError'; }
