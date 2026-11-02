import {ProviderError} from './adapter.ts';
const invalid=()=>new ProviderError('PROVIDER_UNAVAILABLE');
function read<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted){void work.catch(()=>{});return Promise.reject(invalid());}
 return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(invalid());};signal.addEventListener('abort',abort,{once:true});work.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});
}
/** Small control-plane JSON only; never use this for document bytes. */
export async function googleJson(response:Response,options:{signal:AbortSignal;maxBytes:number;check?:()=>void|Promise<void>}):Promise<Record<string,unknown>>{
 const {signal,maxBytes}=options;if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1048576||!response.body)throw invalid();
 const reader=response.body.getReader(),bytes=new Uint8Array(maxBytes);let size=0,empty=0;
 const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
 const check=async()=>{if(signal.aborted)throw invalid();if(options.check)await options.check();if(signal.aborted)throw invalid();};
 try{
  for(;;){await check();const part=await read(reader.read(),signal);await check();if(part.done)break;
   if(size+part.value.byteLength>maxBytes||part.value.byteLength===0&&++empty>65536)throw invalid();bytes.set(part.value,size);size+=part.value.byteLength;
  }
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)));if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();await check();return value as Record<string,unknown>;
 }finally{signal.removeEventListener('abort',cancel);cancel();try{reader.releaseLock();}catch{/* Pending cancelled reads own their remaining cleanup. */}}
}
