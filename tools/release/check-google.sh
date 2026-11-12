#!/bin/sh
# Read-only connectivity diagnostics from the same container/runtime as OAuth.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
docker compose exec -T web node --input-type=module <<'JS'
import {lookup} from 'node:dns/promises';
import https from 'node:https';
const hosts=['oauth2.googleapis.com','www.googleapis.com','openidconnect.googleapis.com'];
const code=e=>e?.cause?.code??e?.code??e?.name??'UNKNOWN';
console.log(JSON.stringify({node:process.version,proxyConfigured:{HTTP_PROXY:!!process.env.HTTP_PROXY,HTTPS_PROXY:!!process.env.HTTPS_PROXY,ALL_PROXY:!!process.env.ALL_PROXY,NO_PROXY:!!process.env.NO_PROXY,http_proxy:!!process.env.http_proxy,https_proxy:!!process.env.https_proxy},nodeEnvProxy:process.env.NODE_USE_ENV_PROXY==='1'||!!process.env.NODE_OPTIONS?.includes('--use-env-proxy'),extraCAConfigured:!!process.env.NODE_EXTRA_CA_CERTS}));
function ipv4(url){return new Promise(resolve=>{const start=Date.now();const request=https.get(url,{family:4},response=>{response.resume();resolve({status:response.statusCode,ms:Date.now()-start});});request.setTimeout(8000,()=>request.destroy(Object.assign(new Error('timeout'),{code:'TIMEOUT'})));const timer=setTimeout(()=>request.destroy(Object.assign(new Error('timeout'),{code:'TIMEOUT'})),8000);request.once('close',()=>clearTimeout(timer));request.on('error',error=>resolve({error:code(error),ms:Date.now()-start}));});}
await Promise.all(hosts.map(async host=>{
 let dns;try{dns=await lookup(host,{all:true});}catch(error){dns={error:code(error)};}
 // Any HTTP response (including 400/401/404/405) proves reachability, not OAuth validity.
 const url='https://'+host+(host==='oauth2.googleapis.com'?'/token':host==='www.googleapis.com'?'/drive/v3/files':'/v1/userinfo');
 const start=Date.now();let result;try{const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(8000)});result={status:response.status,ms:Date.now()-start};await response.body?.cancel();}catch(error){result={error:code(error),ms:Date.now()-start};}
 console.log(JSON.stringify({host,dns,nodeFetch:result,directIPv4:await ipv4(url)}));
}));
JS
