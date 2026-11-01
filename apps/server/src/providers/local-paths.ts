import {constants} from 'node:fs';
import {open,realpath,type FileHandle} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {ProviderError,safeProviderError} from './adapter.ts';
const directoryFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
export const localFileFlags=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
export function localReference(reference:string):string[]{
 if(typeof reference!=='string'||!reference||reference.length>4096||Buffer.from(reference).toString('utf8')!==reference||/[\x00-\x1f\x7f\\]/.test(reference))throw new ProviderError('PROVIDER_INVALID_REFERENCE');
 const parts=reference.split('/');if(parts.length>32||parts.some(p=>!p||p==='.'||p==='..'||p.startsWith('.yourwiki-delivery-')||Buffer.byteLength(p)>255))throw new ProviderError('PROVIDER_INVALID_REFERENCE');return parts;
}
/** Only the administrator's explicit root is resolved. Every object parent is pinned. */
export class LocalPaths {
 private root:FileHandle;private handles=new Set<FileHandle>();private closed=false;
 private constructor(root:FileHandle){this.root=root;this.handles.add(root);}
 static async open(root:string){if(process.platform!=='linux'||typeof root!=='string'||!isAbsolute(root))throw new ProviderError('PROVIDER_INVALID_REFERENCE');return new LocalPaths(await open(await realpath(root),directoryFlags));}
 async own(path:string,flags:number,mode?:number){if(this.closed)throw new ProviderError('PROVIDER_CANCELLED');const handle=await open(path,flags,mode);if(this.closed){await handle.close();throw new ProviderError('PROVIDER_CANCELLED');}this.handles.add(handle);return handle;}
 async release(handle:FileHandle){if(handle===this.root)return;if(this.handles.delete(handle))try{await handle.close();}catch(error){throw safeProviderError(error);}}
 async parent(reference:string){const parts=localReference(reference);let parent=this.root;if(this.closed)throw new ProviderError('PROVIDER_CANCELLED');try{for(const part of parts.slice(0,-1)){const next=await this.own(`/proc/self/fd/${parent.fd}/${part}`,directoryFlags);await this.release(parent);parent=next;}return {handle:parent,name:parts.at(-1)!,path:`/proc/self/fd/${parent.fd}`};}catch(error){await this.release(parent);throw error;}}
 assertOpen(){if(this.closed)throw new ProviderError('PROVIDER_CANCELLED');}
 async close(){this.closed=true;const handles=[...this.handles];this.handles.clear();try{await Promise.all(handles.map(h=>h.close()));}catch(error){throw safeProviderError(error);}}
}
