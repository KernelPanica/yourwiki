import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PdfRangeSource} from '../src/pdf-range-source.ts';
import {blockSession,resumeSession,sessionSnapshot} from '../src/session-fence.ts';
test('PDF ranges abort on account change and never fetch under a new session',async()=>{
 resumeSession();const snapshot=sessionSnapshot();let calls=0,signal:AbortSignal|undefined,deliver=0;
 const original=globalThis.fetch;
 globalThis.fetch=async(_url,init)=>{calls++;signal=init?.signal as AbortSignal;return await new Promise<Response>((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));};
 try{
  const source=new PdfRangeSource('/private.pdf',100,snapshot,()=>deliver++,()=>assert.fail('session cancellation is not an IO error'));
  source.request(0,50);assert.equal(calls,1);blockSession();assert.equal(signal?.aborted,true);
  resumeSession();source.request(50,100);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(calls,1);assert.equal(deliver,0);source.abort();
 }finally{globalThis.fetch=original;resumeSession();}
});
test('PDF ranges validate the response before delivering bytes',async()=>{
 resumeSession();const original=globalThis.fetch;let delivered:Uint8Array|undefined,errors=0;
 globalThis.fetch=async()=>new Response(new Uint8Array([1,2]),{status:206,headers:{'content-range':'bytes 2-3/10'}});
 try{const source=new PdfRangeSource('/private.pdf',10,sessionSnapshot(),(_begin,data)=>{delivered=data;},()=>errors++);
 await source.request(2,4);assert.deepEqual(delivered,new Uint8Array([1,2]));
 await source.request(0,2);assert.equal(errors,1);source.abort();}finally{globalThis.fetch=original;}
});
