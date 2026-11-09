import {request} from 'node:https';
import {lookup} from 'node:dns';
import {isIP} from 'node:net';
import {DocumentError} from '../document-errors.ts';
import {invalid} from './validation.ts';
export type AiTransport=(url:URL,headers:Record<string,string>,body:string,signal:AbortSignal)=>Promise<unknown>;
/** Conservative routable address policy; the checked DNS address is the address TLS connects to. */
export function publicAddress(value:string){
 if(isIP(value)===4){const [a,b,c]=value.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b!>=16&&b!<=31||a===192&&(b===168||b===0||b===2)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113||a===100&&b!>=64&&b!<=127);}
 if(isIP(value)===6){const host=value.toLowerCase();return /^[23]/.test(host)&&!host.startsWith('2001:db8:')&&!host.startsWith('2001:0:')&&!host.startsWith('2002:');}return false;
}
export function endpoint(value:string){let url:URL;try{url=new URL(value);}catch{return invalid();}if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port&&url.port!=='443'||url.hostname.endsWith('.')||url.hostname==='localhost'||url.hostname.endsWith('.localhost')||isIP(url.hostname.replace(/^\[|\]$/g,''))&&!publicAddress(url.hostname.replace(/^\[|\]$/g,'')))invalid();return url;}
/** One bounded HTTPS POST. Never redirect, retry, use environment proxies, or return provider errors. */
export const httpsAiTransport:AiTransport=(url,headers,body,signal)=>new Promise((resolve,reject)=>{
 let settled=false;const finish=(error?:unknown,value?:unknown)=>{if(settled)return;settled=true;error?reject(error):resolve(value);};
 const req=request(url,{method:'POST',headers:{...headers,'content-type':'application/json','content-length':String(Buffer.byteLength(body))},signal,lookup:(hostname,options,callback)=>{lookup(hostname,{all:true,verbatim:true},(error,addresses)=>{if(error)return callback(error,'',4);if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))return callback(new Error('Endpoint denied'),'',4);if(options.all)(callback as any)(null,addresses);else callback(null,addresses[0]!.address,addresses[0]!.family);});}},response=>{
  if(!response.statusCode||response.statusCode<200||response.statusCode>=300){response.destroy();finish(new DocumentError(response.statusCode===401||response.statusCode===403?'AI_AUTH_FAILED':response.statusCode===429?'AI_QUOTA_LIMIT':response.statusCode===404?'AI_MODEL_UNAVAILABLE':'AI_PROVIDER_REJECTED'));return;}
  const chunks:Buffer[]=[];let size=0;response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1024**2){response.destroy();finish(new DocumentError('AI_RESPONSE_TOO_LARGE'));return;}chunks.push(chunk);});response.on('error',()=>finish(new DocumentError('AI_UNAVAILABLE')));response.on('end',()=>{try{finish(undefined,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(new DocumentError('AI_INVALID_RESPONSE'));}});
 });req.on('error',()=>finish(new DocumentError('AI_UNAVAILABLE')));req.end(body);
});
