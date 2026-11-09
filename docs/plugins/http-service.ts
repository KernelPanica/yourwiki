/** Single-file YourWiki API v1 plugin. No npm installation is required. */
type Context={action:string;config:Record<string,string>;input:Record<string,string>;user:{id:string};fetch:typeof globalThis.fetch};
export default {
 id:'http-service',name:'HTTP service',version:'1.0.0',
 description:'Connect any HTTP API using a configurable base URL and optional Bearer token.',
 fields:[{key:'baseUrl',label:'API base URL',type:'url',required:true},{key:'apiKey',label:'Bearer token',type:'secret'}],
 actions:[{id:'request',label:'GET request',description:'Send an explicit request to the configured service.',fields:[{key:'path',label:'API path (for example /health)',type:'text',required:true}]}],
 async execute({config,input,fetch}:Context){
  const base=new URL(config.baseUrl),url=new URL(input.path,base);
  if(url.origin!==base.origin)throw new Error('Path must remain on the configured API origin');
  const response=await fetch(url,{headers:{Accept:'application/json',...(config.apiKey?{Authorization:'Bearer '+config.apiKey}:{})},signal:AbortSignal.timeout(10000)});
  // Do not return request headers or credentials in results.
  return {status:response.status,ok:response.ok,body:(await response.text()).slice(0,32000)};
 }
};
