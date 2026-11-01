import {ApiError} from './api.ts';
declare const __ARCHIVE_HASH_WORKER__:string;
/** Dedicated worker is terminated on session/selection cancellation; File bytes never cross back to the main thread. */
export function hashArchiveFile(file:Blob,signal:AbortSignal,progress:(bytes:number)=>void=()=>{}):Promise<string>{
 return new Promise((resolve,reject)=>{if(signal.aborted){reject(signal.reason);return;}let worker:Worker;try{worker=new Worker(__ARCHIVE_HASH_WORKER__,{type:'module'});}catch{reject(new ApiError('HISTORY_HASH_UNAVAILABLE'));return;}let settled=false,previous=0;
  const finish=(error:unknown,digest?:string)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);worker.terminate();if(error)reject(error);else resolve(digest!);},abort=()=>finish(signal.reason??new DOMException('Aborted','AbortError'));
  signal.addEventListener('abort',abort,{once:true});worker.onerror=()=>finish(new ApiError('HISTORY_HASH_UNAVAILABLE'));worker.onmessage=event=>{const value=event.data;if(value?.type==='progress'&&Number.isSafeInteger(value.bytes)&&value.bytes>=previous&&value.bytes<=file.size){previous=value.bytes;progress(value.bytes);}else if(value?.type==='done'&&typeof value.digest==='string'&&/^[a-f0-9]{64}$/.test(value.digest))finish(null,value.digest);else finish(new ApiError('HISTORY_HASH_UNAVAILABLE'));};try{worker.postMessage(file);}catch{finish(new ApiError('HISTORY_HASH_UNAVAILABLE'));}
 });
}
