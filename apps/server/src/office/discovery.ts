import {SaxesParser} from 'saxes';
import {OfficeError} from './sessions.ts';
type Action={ext:string;name:string;url:string};
export function officeUrl(value:string){
 const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Invalid office URL');
 url.pathname=url.pathname.replace(/\/$/,'');return url;
}
async function interrupt<T>(promise:Promise<T>,signal:AbortSignal){
 signal.throwIfAborted();let abort!:()=>void;
 try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]);}
 finally{signal.removeEventListener('abort',abort);}
}
export class OfficeDiscovery {
 private publicUrl:URL;private internalUrl:URL;private fetch:typeof fetch;private clock:()=>number;private timeout:number;
 private cached:Action[]|undefined;private until=0;private loading:Promise<Action[]>|undefined;
 constructor(options:{publicUrl:string;internalUrl?:string;fetch?:typeof fetch;clock?:()=>number;timeoutMs?:number}){
  this.publicUrl=officeUrl(options.publicUrl);this.internalUrl=officeUrl(options.internalUrl??options.publicUrl);this.fetch=options.fetch??globalThis.fetch;this.clock=options.clock??Date.now;this.timeout=options.timeoutMs??5000;
  if(!Number.isSafeInteger(this.timeout)||this.timeout<1||this.timeout>60_000)throw new Error('Invalid office discovery timeout');
 }
 private async load(){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeout);let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
   const response=await interrupt(this.fetch(this.internalUrl.href.replace(/\/$/,'')+'/hosting/discovery',{redirect:'error',signal:controller.signal}),controller.signal);
   if(response.status!==200||!response.body)throw new OfficeError('OFFICE_UNAVAILABLE');
   if(Number(response.headers.get('content-length')??0)>2*1024**2)throw new OfficeError('INVALID_OFFICE_DISCOVERY');
   reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
   while(true){const {done,value}=await interrupt(reader.read(),controller.signal);if(done)break;size+=value.byteLength;if(size>2*1024**2)throw new OfficeError('INVALID_OFFICE_DISCOVERY');chunks.push(value);}
   const xml=Buffer.concat(chunks).toString('utf8'),actions:Action[]=[];let depth=0;
   const invalid=()=>{throw new OfficeError('INVALID_OFFICE_DISCOVERY');};
   const parser=new SaxesParser({xmlns:true});parser.on('doctype',invalid);parser.on('error',invalid);
   parser.on('opentag',tag=>{
    if(++depth>64||(depth===1&&tag.local!=='wopi-discovery'))invalid();
    if(tag.local==='action'){
     if(actions.length>=10000)invalid();const attr=(name:string)=>tag.attributes[name]?.value??'';
     actions.push({ext:attr('ext'),name:attr('name'),url:attr('urlsrc')});
    }
   });parser.on('closetag',()=>{depth--;});parser.write(xml).close();
   return actions;
  }catch(error){if(error instanceof OfficeError)throw error;throw new OfficeError('OFFICE_UNAVAILABLE');}
  finally{clearTimeout(timer);void reader?.cancel().catch(()=>{});controller.abort();}
 }
 async action(extension:string,writable:boolean){
  if(!this.cached||this.until<=this.clock()){
   this.loading??=this.load().then(value=>{this.cached=value;this.until=this.clock()+300_000;return value;}).finally(()=>{this.loading=undefined;});await this.loading;
  }
  const names=writable?['edit']:['view','edit'];let selected:Action|undefined;
  for(const name of names){selected=this.cached!.find(item=>item.ext===extension&&item.name===name);if(selected)break;}
  if(!selected)throw new OfficeError('UNSUPPORTED_OFFICE_FORMAT');
  let path:string;try{const url=new URL(selected.url);if(!['http:','https:'].includes(url.protocol))throw new Error();path=url.pathname;}catch{throw new OfficeError('INVALID_OFFICE_DISCOVERY');}
  const prefix=this.publicUrl.pathname.replace(/\/$/,'');
  if(!path.startsWith(prefix+'/browser/')||!path.endsWith('/cool.html')||/[%\\]/.test(path)||path.split('/').some(part=>part==='.'||part==='..'))throw new OfficeError('INVALID_OFFICE_DISCOVERY');
  return this.publicUrl.origin+path;
 }
}
