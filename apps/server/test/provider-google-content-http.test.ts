import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {GoogleContentHttp} from '../src/providers/google-content-http.ts';
const allowed={check(){}};
function auth(){let count=0;const invalidated:string[]=[];return {access:async()=> 'SYNTHETIC-'+(++count),invalidate:(token:string)=>invalidated.push(token),count:()=>count,invalidated};}
async function collect(source:AsyncIterable<Uint8Array>){const chunks:Buffer[]=[];for await(const value of source){assert.ok(value.byteLength<=65536);chunks.push(Buffer.from(value));}return Buffer.concat(chunks);}
test('binary GET is lazy, fixed-origin and streams exact bytes in at most64KiB pieces',async t=>{
 const a=auth(),data=Buffer.alloc(200000,0x6d);let calls=0;const http=new GoogleContentHttp(a,{fetch:async(url,init)=>{calls++;assert.equal(String(url),'https://www.googleapis.com/drive/v3/files/file?alt=media');assert.equal(init?.method,'GET');assert.equal(init?.redirect,'manual');assert.equal(init?.body,undefined);assert.equal((init?.headers as any).authorization,'Bearer SYNTHETIC-1');assert.equal((init?.headers as any)['accept-encoding'],'identity');return new Response(data,{headers:{'content-length':String(data.length)}});}});t.after(()=>http.close());
 const stream=http.binary('file',data.length,allowed);assert.equal(calls,0);assert.deepEqual(await collect(stream),data);assert.equal(calls,1);
});
test('export uses an explicit fixed native format and a bounded unknown length rather than alt=media',async t=>{
 for(const [kind,mime] of [['document','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],['spreadsheet','application/vnd.oasis.opendocument.spreadsheet'],['presentation','application/vnd.openxmlformats-officedocument.presentationml.presentation']] as const){
  const http=new GoogleContentHttp(auth(),{fetch:async(url)=>{const parsed=new URL(String(url));assert.equal(parsed.pathname,'/drive/v3/files/native/export');assert.equal(parsed.searchParams.get('mimeType'),mime);assert.equal(parsed.searchParams.has('alt'),false);return new Response('exported');}});t.after(()=>http.close());assert.equal((await collect(http.export('native',kind,allowed))).toString(),'exported');
 }
});
test('invalid identities/sizes/export kinds never contact OAuth or HTTP',async t=>{
 const a=auth(),http=new GoogleContentHttp(a,{fetch:async()=>{throw new Error('must not fetch');}});t.after(()=>http.close());
 for(const id of ['../private','https://evil.invalid/file',''])assert.throws(()=>http.binary(id,1,allowed));
 for(const size of [-1,1.5,4294967297,NaN])assert.throws(()=>http.binary('file',size,allowed));assert.throws(()=>http.export('native','shortcut' as any,allowed));assert.equal(a.count(),0);
});
test('short, oversized, inconsistent-length, encoded and partial responses refuse without leaking provider text',async t=>{
 for(const response of [new Response('ab'),new Response('abcd'),new Response('abc',{headers:{'content-length':'2'}}),new Response('abc',{headers:{'content-encoding':'gzip'}}),new Response('private',{status:206,headers:{'content-range':'bytes 0-6/100'}})]){
  const http=new GoogleContentHttp(auth(),{fetch:async()=>response});t.after(()=>http.close());await assert.rejects(collect(http.binary('file',3,allowed)),(e:any)=>{assert.ok(['PROVIDER_SOURCE_CHANGED','PROVIDER_UNAVAILABLE'].includes(e.code));assert.equal(e.message,e.code);return true;});
 }
});
test('empty binary succeeds but exports above the bounded provider budget are explicit failures',async t=>{
 const empty=new GoogleContentHttp(auth(),{fetch:async()=>new Response(null,{headers:{'content-length':'0'}})});t.after(()=>empty.close());assert.equal((await collect(empty.binary('empty',0,allowed))).length,0);
 for(const declared of [true,false]){const http=new GoogleContentHttp(auth(),{fetch:async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(65536));}}),{headers:declared?{'content-length':'999999999'}:{}})});t.after(()=>http.close());await assert.rejects(collect(http.export('native','document',allowed)),{code:'PROVIDER_EXPORT_LIMIT'});}
});
test('only a pre-body401 gets one fresh-token GET retry; a body failure never replays',async t=>{
 const a=auth();let calls=0;const http=new GoogleContentHttp(a,{fetch:async()=>++calls===1?new Response('private',{status:401}):new Response('abc')});t.after(()=>http.close());assert.equal((await collect(http.binary('file',3,allowed))).toString(),'abc');assert.deepEqual(a.invalidated,['SYNTHETIC-1']);assert.equal(calls,2);
 let brokenCalls=0;const broken=new GoogleContentHttp(auth(),{fetch:async()=>{brokenCalls++;return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));},pull(c){c.error(new Error('private transport credentials'));}}));}});t.after(()=>broken.close());await assert.rejects(collect(broken.binary('file',3,allowed)),{code:'PROVIDER_UNAVAILABLE',message:'PROVIDER_UNAVAILABLE'});assert.equal(brokenCalls,1);
});
test('known HTTP errors stay static and do not follow redirects or infer trash from404',async t=>{
 for(const [status,reason,code] of [[302,'','PROVIDER_UNAVAILABLE'],[404,'','PROVIDER_SOURCE_CHANGED'],[412,'','PROVIDER_CONFLICT'],[403,'insufficientFilePermissions','ACCESS_DENIED'],[403,'downloadQuotaExceeded','PROVIDER_UNAVAILABLE'],[403,'exportSizeLimitExceeded','PROVIDER_EXPORT_LIMIT'],[429,'','PROVIDER_UNAVAILABLE'],[500,'','PROVIDER_UNAVAILABLE'],[401,'','PROVIDER_CONFIG_CHANGED']] as const){let calls=0;const http=new GoogleContentHttp(auth(),{fetch:async()=>{calls++;return Response.json({error:{message:'SYNTHETIC-PRIVATE',errors:[{reason}]}},{status,headers:{location:'https://private.invalid'}});}});t.after(()=>http.close());await assert.rejects(collect(http.export('native','document',allowed)),{code,message:code});assert.equal(calls,status===401?2:1);}
});
test('revocation during streaming retains the trusted error and cancels bytes without retry',async t=>{
 let revoked=false,cancelled=false;const http=new GoogleContentHttp(auth(),{fetch:async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;}}))});t.after(()=>http.close());const stream=http.binary('file',2,{check(){if(revoked)throw new Error('SESSION_REQUIRED');}})[Symbol.asyncIterator]();assert.equal((await stream.next()).value?.length,1);revoked=true;await assert.rejects(stream.next(),{message:'SESSION_REQUIRED'});assert.equal(cancelled,true);
});
test('close drains both stalled and consumer-paused streams and cancels a late ignored-abort response',async()=>{
 const paused=new GoogleContentHttp(auth(),{fetch:async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array([1]));}}))}),iterator=paused.binary('file',2,allowed)[Symbol.asyncIterator]();await iterator.next();await paused.close();
 let release!:(r:Response)=>void,reached!:()=>void,cancelled=false;const ready=new Promise<void>(r=>reached=r),gate=new Promise<Response>(r=>release=r),http=new GoogleContentHttp(auth(),{fetch:async()=>{reached();return gate;}}),pending=collect(http.binary('file',1,allowed)),refused=assert.rejects(pending,{code:'PROVIDER_CANCELLED'});await ready;await http.close();await refused;
 release(new Response(new ReadableStream({cancel(){cancelled=true;}})));await new Promise(r=>setImmediate(r));assert.equal(cancelled,true);
});
for(const mode of ['success','redirect','stalled','short','reauth','export','total'])test('native HTTP binary stream '+mode,async t=>{
 let calls=0,redirects=0;const server=createServer((req,res)=>{calls++;if(req.url==='/elsewhere'){redirects++;res.end('bad');return;}assert.equal(req.method,'GET');if(mode==='export')assert.ok(req.url?.startsWith('/drive/v3/files/native/export?mimeType='));else assert.ok(req.url?.endsWith('?alt=media'));
 if(mode==='total'){res.writeHead(200);const timer=setInterval(()=>res.write('a'),5);req.on('close',()=>clearInterval(timer));}else if(mode==='redirect'){res.writeHead(302,{location:'/elsewhere'});res.end();}else if(mode==='stalled'){res.writeHead(200);res.write('a');}else if(mode==='reauth'&&calls===1){res.writeHead(401);res.end();}else{res.end(mode==='short'?'ab':'abc');}
 });server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port,http=new GoogleContentHttp(auth(),{timeoutMs:mode==='stalled'?100:3000,totalMs:mode==='total'?50:1800000,fetch:async(url,init)=>{const parsed=new URL(String(url));assert.equal(parsed.origin,'https://www.googleapis.com');return fetch('http://127.0.0.1:'+port+parsed.pathname+parsed.search,init);}});t.after(async()=>{await http.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 if(mode==='success'||mode==='reauth'||mode==='export')assert.equal((await collect(mode==='export'?http.export('native','document',allowed):http.binary('file',3,allowed))).toString(),'abc');else await assert.rejects(collect(http.binary('file',mode==='total'?100:3,allowed)),{code:mode==='short'?'PROVIDER_SOURCE_CHANGED':'PROVIDER_UNAVAILABLE'});assert.equal(redirects,0);assert.equal(calls,mode==='reauth'?2:1);
});
test('closing a consumer-paused stream cannot masquerade as successful EOF on its next read',async()=>{
 const http=new GoogleContentHttp(auth(),{fetch:async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array([1]));}}))}),iterator=http.binary('file',2,allowed)[Symbol.asyncIterator]();await iterator.next();await http.close();await assert.rejects(iterator.next(),{code:'PROVIDER_CANCELLED'});
});
test('bounded active streams release admission after an abandoned consumer returns',async t=>{
 const http=new GoogleContentHttp(auth(),{fetch:async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array([1]));}}))});t.after(()=>http.close());const first=http.binary('file',2,allowed)[Symbol.asyncIterator](),second=http.binary('file',2,allowed)[Symbol.asyncIterator]();await first.next();await second.next();await assert.rejects(collect(http.binary('third',2,allowed)),{code:'PROVIDER_UNAVAILABLE'});await first.return?.();const third=http.binary('third',2,allowed)[Symbol.asyncIterator]();assert.equal((await third.next()).value?.[0],1);await third.return?.();
});

test('empty stream chunks have a finite work budget even without byte progress',async t=>{
 let chunks=0;const http=new GoogleContentHttp(auth(),{fetch:async()=>new Response(new ReadableStream({pull(controller){chunks++;controller.enqueue(new Uint8Array(0));}}))});t.after(()=>http.close());await assert.rejects(collect(http.binary('file',0,allowed)),{code:'PROVIDER_UNAVAILABLE'});assert.ok(chunks<=65538);
});
