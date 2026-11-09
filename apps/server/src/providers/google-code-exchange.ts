import {ProviderError,type ProviderCheck} from './adapter.ts';
import {DocumentError} from '../document-errors.ts';
import type {GoogleConnectStates} from './google-connect-state.ts';
import {googleJson} from './google-json.ts';
type Lease=ReturnType<GoogleConnectStates['claim']>;
const consumed=new WeakSet<Lease>(),scope='https://www.googleapis.com/auth/drive';
const unavailable=()=>new ProviderError('PROVIDER_UNAVAILABLE');
function interrupt<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted){void work.catch(()=>{});return Promise.reject(unavailable());}
 return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(unavailable());};signal.addEventListener('abort',abort,{once:true});work.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});
}
function token(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=65536&&!/[^\x21-\x7e]/.test(value);}
/** Private one-shot code exchange. A claimed consent is never retried or published as a connection here. */
export class GoogleCodeExchange{
 private request:typeof fetch;private timeoutMs:number;private clock:()=>number;private closed=false;private active=new Map<AbortController,Promise<void>>();private draining:Promise<void>|undefined;
 constructor(options:{fetch?:typeof fetch;timeoutMs?:number;clock?:()=>number}={}){
  this.request=options.fetch??fetch;this.timeoutMs=options.timeoutMs??30000;this.clock=options.clock??(()=>performance.now());if(!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>30000)throw new ProviderError('PROVIDER_CONFIG_CHANGED');
 }
 private now(){const now=this.clock();if(!Number.isFinite(now)||now<0||now>Number.MAX_SAFE_INTEGER)throw unavailable();return now;}
 async exchange(lease:Lease,code:string,options:ProviderCheck){
  if(typeof code!=='string'||code.length<1||code.length>8192||/[^\x21-\x7e]/.test(code))throw new ProviderError('PROVIDER_INVALID_REFERENCE');
  if(this.closed||options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');if(consumed.has(lease)||this.active.size>=4)throw new ProviderError('PROVIDER_CONFIG_CHANGED');consumed.add(lease);
  const controller=new AbortController();let done!:()=>void;this.active.set(controller,new Promise<void>(r=>done=r));const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();const timer=setTimeout(abort,this.timeoutMs);let response:Response|undefined;
  const guard=async()=>{if(controller.signal.aborted)throw unavailable();lease.check();await interrupt(Promise.resolve().then(()=>options.check()),controller.signal);lease.check();if(controller.signal.aborted)throw unavailable();};
  try{
   const started=this.now();await guard();const credentials=lease.credentials();if(!token(credentials.clientId)||credentials.clientId.length>2048||!token(credentials.clientSecret)||!/^[-A-Za-z0-9._~]{43,128}$/.test(credentials.codeVerifier))throw new ProviderError('PROVIDER_CONFIG_CHANGED');
   const redirect=new URL(credentials.redirectUri);if(redirect.href!==credentials.redirectUri||redirect.username||redirect.password||redirect.hash||redirect.search||redirect.pathname!=='/api/admin/google/oauth/callback'||redirect.protocol!=='https:'&&!(redirect.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(redirect.hostname)))throw new ProviderError('PROVIDER_CONFIG_CHANGED');
   const current=await interrupt<Response>(this.request('https://oauth2.googleapis.com/token',{method:'POST',redirect:'manual',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal,headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body:new URLSearchParams({grant_type:'authorization_code',code,client_id:credentials.clientId,client_secret:credentials.clientSecret,redirect_uri:credentials.redirectUri,code_verifier:credentials.codeVerifier})}).then(value=>{if(controller.signal.aborted){void value.body?.cancel().catch(()=>{});throw unavailable();}return value;}),controller.signal);response=current;await guard();
   if(current.status>=300&&current.status<400)throw unavailable();const value=await googleJson(current,{signal:controller.signal,maxBytes:65536,check:guard});await guard();
   if(current.status!==200){if(current.status>=400&&current.status<600&&typeof value.error==='string'&&['invalid_request','invalid_client','invalid_grant','unauthorized_client','unsupported_grant_type','invalid_scope'].includes(value.error)&&!Object.hasOwn(value,'access_token')&&!Object.hasOwn(value,'refresh_token'))throw new DocumentError(['invalid_client','unauthorized_client'].includes(value.error)?'GOOGLE_OAUTH_CLIENT':value.error==='invalid_grant'?'GOOGLE_OAUTH_EXPIRED':'GOOGLE_OAUTH_SCOPE');throw unavailable();}
   if(!token(value.access_token)||!token(value.refresh_token)||typeof value.token_type!=='string'||value.token_type.toLowerCase()!=='bearer'||!Number.isSafeInteger(value.expires_in)||Number(value.expires_in)<=0||value.scope!==undefined&&(typeof value.scope!=='string'||value.scope.length>65536||/[^\x20-\x7e]/.test(value.scope)||!value.scope.split(' ').includes(scope)))throw unavailable();
   const lifetime=Number(value.expires_in)*1000,expiresAt=started+lifetime-Math.min(60000,lifetime*.1),accessToken=value.access_token,refreshToken=value.refresh_token;
   const check=()=>{if(this.closed||options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');lease.check();const now=this.now();if(!Number.isFinite(expiresAt)||expiresAt>Number.MAX_SAFE_INTEGER||now<started||now>=expiresAt)throw unavailable();};check();
   return Object.freeze({credentials:()=>{check();return {accessToken,refreshToken};},check});
  }catch(error){if(this.closed||options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');if(error instanceof DocumentError&&['SESSION_REQUIRED','ACCESS_DENIED','CSRF_REJECTED','INVALID_REQUEST','CONFLICT','CONFIG_UNAVAILABLE','GOOGLE_OAUTH_CLIENT','GOOGLE_OAUTH_EXPIRED','GOOGLE_OAUTH_SCOPE'].includes(error.code))throw new DocumentError(error.code);if(error instanceof ProviderError)throw error;throw unavailable();}
  finally{void response?.body?.cancel().catch(()=>{});clearTimeout(timer);options.signal?.removeEventListener('abort',abort);controller.abort();this.active.delete(controller);done();}
 }
 close():Promise<void>{if(this.draining)return this.draining;this.closed=true;const pending=[...this.active.values()];for(const controller of this.active.keys())controller.abort();this.draining=Promise.all(pending).then(()=>{});return this.draining;}
}
