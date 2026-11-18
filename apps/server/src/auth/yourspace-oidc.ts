import {createPublicKey,verify} from 'node:crypto';
import type {webcrypto} from 'node:crypto';
export type YourspaceLoginOptions={issuer:string;clientId:string;clientSecret:string;fetch?:typeof fetch};
export class YourspaceError extends Error{kind:'invalid'|'unavailable'|'unlinked'|'mfa_required';constructor(kind:'invalid'|'unavailable'|'unlinked'|'mfa_required'){super(kind);this.kind=kind;}}
const bad=():never=>{throw new YourspaceError('invalid');};
export function issuerOrigin(value:string){const u=new URL(value);if(u.username||u.password||u.hash||u.search||u.pathname!=='/'||u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))bad();return u.origin;}
export class YourspaceOidc{
 readonly issuer:string;readonly clientId:string;private secret:string;private fetch:typeof fetch;
 private metadata:Record<string,string>|undefined;private until=0;
 constructor(options:YourspaceLoginOptions){this.issuer=issuerOrigin(options.issuer);this.clientId=options.clientId;this.secret=options.clientSecret;this.fetch=options.fetch??fetch;if(!/^[a-z0-9-]{2,40}$/.test(this.clientId)||!this.secret||this.secret.length>512)bad();}
 async json(url:string,init:RequestInit={}){
  if(new URL(url).origin!==this.issuer)bad();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{const r=await this.fetch(url,{...init,redirect:'error',signal:controller.signal});if(r.status===400||r.status===401||r.status===403)bad();if(!r.ok||!r.body)throw new YourspaceError('unavailable');
   const reader=r.body.getReader(),chunks:Uint8Array[]=[];let size=0;try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>131072){await reader.cancel();bad();}chunks.push(value);}}finally{reader.releaseLock();}
   const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))bad();return value as Record<string,any>;
  }catch(e){if(e instanceof YourspaceError)throw e;throw new YourspaceError('unavailable');}finally{clearTimeout(timer);controller.abort();}
 }
 async discovery(){
  if(this.metadata&&this.until>Date.now())return this.metadata;
  const m=await this.json(this.issuer+'/.well-known/openid-configuration');if(m.issuer!==this.issuer)bad();
  for(const key of ['authorization_endpoint','token_endpoint','userinfo_endpoint','jwks_uri','end_session_endpoint']){if(typeof m[key]!=='string')bad();const url=new URL(m[key]);if(url.origin!==this.issuer||url.username||url.password||url.hash)bad();}
  this.metadata=m as Record<string,string>;this.until=Date.now()+300000;return this.metadata;
 }
 async exchange(code:string,verifier:string,nonce:string,redirectUri:string){
  const m=await this.discovery(),response=await this.json(m.token_endpoint,{method:'POST',headers:{authorization:'Basic '+Buffer.from(encodeURIComponent(this.clientId)+':'+encodeURIComponent(this.secret)).toString('base64'),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:redirectUri}).toString()});
  return this.validate(response,nonce);
 }
 async refresh(refreshToken:string,nonce:string,onRotate?:(token:string)=>void){
  const m=await this.discovery(),response=await this.json(m.token_endpoint,{method:'POST',headers:{authorization:'Basic '+Buffer.from(encodeURIComponent(this.clientId)+':'+encodeURIComponent(this.secret)).toString('base64'),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken}).toString()});if(typeof response.refresh_token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(response.refresh_token))bad();onRotate?.(response.refresh_token);return this.validate(response,nonce);
 }
 private async validate(response:Record<string,any>,nonce:string){
  const m=await this.discovery();
  if(typeof response.id_token!=='string'||response.id_token.length>32768||!/^Bearer$/i.test(response.token_type)||typeof response.access_token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(response.access_token)||!Number.isSafeInteger(response.expires_in)||response.expires_in<1||response.expires_in>900)bad();
  const parts=response.id_token.split('.');if(parts.length!==3||parts.some((p:string)=>!p||!/^[A-Za-z0-9_-]+$/.test(p)))bad();
  let h:any,c:any;try{h=JSON.parse(Buffer.from(parts[0],'base64url').toString());c=JSON.parse(Buffer.from(parts[1],'base64url').toString());}catch{bad();}
  if(!h||h.alg!=='RS256'||typeof h.kid!=='string'||h.kid.length>128||h.crit||h.jku||h.x5u)bad();
  const keys=await this.json(m.jwks_uri);if(!Array.isArray(keys.keys)||keys.keys.length>32)bad();const matches=keys.keys.filter((key:any)=>key.kid===h.kid&&key.kty==='RSA'&&(!key.alg||key.alg==='RS256')&&(!key.use||key.use==='sig'));
  if(matches.length!==1)bad();try{const key=createPublicKey({key:matches[0] as webcrypto.JsonWebKey,format:'jwk'});if((key.asymmetricKeyDetails?.modulusLength??0)<2048||!verify('sha256',Buffer.from(parts[0]+'.'+parts[1]),key,Buffer.from(parts[2],'base64url')))bad();}catch{bad();}
  const now=Math.floor(Date.now()/1000),aud=typeof c?.aud==='string'?[c.aud]:c?.aud;
  if(!c||c.iss!==this.issuer||!Array.isArray(aud)||!aud.includes(this.clientId)||aud.length>1&&c.azp!==this.clientId||c.azp!==undefined&&c.azp!==this.clientId||c.nonce!==nonce||typeof c.sub!=='string'||!c.sub||c.sub.length>128||/[\x00-\x20\x7f]/.test(c.sub)||!Number.isSafeInteger(c.exp)||c.exp<=now||c.exp>now+900||!Number.isSafeInteger(c.iat)||c.iat>now+30||c.iat>c.exp)bad();
  const info=await this.userinfo(response.access_token);if(info.sub!==c.sub)bad();
  if(response.refresh_token!==undefined&&(typeof response.refresh_token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(response.refresh_token)))bad();
  return {refreshToken:response.refresh_token as string|undefined,subject:c.sub as string,mfa:Array.isArray(c.amr)&&c.amr.includes('mfa'),accessToken:response.access_token as string,expiresAt:Math.min(c.exp*1000,Date.now()+response.expires_in*1000)};
 }
 async userinfo(token:string){const m=await this.discovery(),info=await this.json(m.userinfo_endpoint,{headers:{authorization:'Bearer '+token}});if(typeof info.sub!=='string'||!info.sub||info.yourspace_status==='left')bad();return info;}
 logoutUrl(returnUri:string){return this.issuer+'/oauth/logout?'+new URLSearchParams({client_id:this.clientId,post_logout_redirect_uri:returnUri}).toString();}
}
