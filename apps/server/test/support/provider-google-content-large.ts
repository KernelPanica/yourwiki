/** Owned loopback proof only: actual4GiB HTTP body, 48MiB old-space, no real Google credentials. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {getHeapStatistics} from 'node:v8';
import {GoogleBinaryReader} from '../../src/providers/google-binary-reader.ts';
import {GoogleContentHttp} from '../../src/providers/google-content-http.ts';
assert.ok(process.execArgv.includes('--max-old-space-size=48'),'Run owned large transfer with explicit48MiB old-space cap');
const composition=process.argv.includes('--binary-reader');
const total=4294967296,block=Buffer.alloc(65536,0x6d),last=Buffer.from(block);last.fill(0x7e,last.length-257);let served=0,requests=0,metadataRequests=0,sourceHash='',serverError:unknown;
const started=performance.now(),server=createServer((req,res)=>{void(async()=>{
 requests++;assert.equal(req.method,'GET');assert.equal(req.headers.authorization,'Bearer SYNTHETIC');
 const url=new URL(req.url!,'http://owned.invalid');if(url.searchParams.get('alt')!=='media'){
  assert.equal(composition,true);metadataRequests++;const id=url.pathname.split('/').at(-1)!;assert.ok(['rootId','owned-large'].includes(id));res.setHeader('content-type','application/json');res.end(JSON.stringify({id,mimeType:id==='rootId'?'application/vnd.google-apps.folder':'application/octet-stream',version:'1',size:String(total),parents:id==='rootId'?[]:['rootId'],ownedByMe:true,trashed:false,shared:false,capabilities:{canDownload:true}}));return;
 }
 assert.equal(req.url,'/drive/v3/files/owned-large?alt=media');res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(total)});
 const hash=createHash('sha256');for(let position=0;position<total;position+=block.length){const chunk=position+block.length===total?last:block;hash.update(chunk);served+=chunk.length;if(!res.write(chunk))await once(res,'drain');}sourceHash=hash.digest('hex');res.end();
 })().catch(error=>{serverError=error;res.destroy();});});
server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;let oauth=0;
const auth={access:async()=>{oauth++;return 'SYNTHETIC';},invalidate(){throw new Error('Unexpected owned reauthentication');}},options={timeoutMs:30000,totalMs:180000,fetch:async(url:Parameters<typeof fetch>[0],init:Parameters<typeof fetch>[1])=>{const parsed=new URL(String(url));assert.equal(parsed.origin,'https://www.googleapis.com');return fetch('http://127.0.0.1:'+port+parsed.pathname+parsed.search,init);}};
const http=new GoogleContentHttp(auth,options),reader=composition?new GoogleBinaryReader('rootId',auth,async()=>[],options):undefined;
try{
 const hash=createHash('sha256');let size=0,chunks=0,tail=Buffer.alloc(0),prefix=Buffer.alloc(0);
 const source=reader?await reader.read('owned-large',{check(){}}):null;if(source)assert.equal(source.size,total);
 for await(const chunk of source?.bytes??http.binary('owned-large',total,{check(){}})){
  assert.ok(chunk.length>0&&chunk.length<=65536);if(!size)prefix=Buffer.from(chunk.subarray(0,32));hash.update(chunk);size+=chunk.length;chunks++;tail=chunk.length>=257?Buffer.from(chunk.subarray(chunk.length-257)):Buffer.concat([tail,chunk]).subarray(-257);
 }
 assert.equal(serverError,undefined);assert.equal(size,total);assert.equal(served,total);assert.equal(hash.digest('hex'),sourceHash);assert.deepEqual(prefix,Buffer.alloc(32,0x6d));assert.deepEqual(tail,Buffer.alloc(257,0x7e));assert.equal(oauth,composition?5:1);assert.equal(requests,composition?5:1);assert.equal(metadataRequests,composition?4:0);assert.ok(process.resourceUsage().maxRSS<256*1024,'Owned content transfer exceeds256MiB RSS budget');
 console.log(JSON.stringify({kind:composition?'owned-http-binary-reader':'owned-http-only',bytes:size,chunks,sourceSha256:sourceHash,requests,metadataRequests,syntheticAuthorizationAccesses:oauth,oldSpaceLimitMiB:48,v8HeapSizeLimitBytes:getHeapStatistics().heap_size_limit,maxRssKiB:process.resourceUsage().maxRSS,elapsedMs:Math.round(performance.now()-started)}));
}finally{await http.close();await reader?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
