import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GoogleBinaryReader} from '../src/providers/google-binary-reader.ts';
const allowed={check(){}};
function fixture(){let version='1',parent='rootId',owned=true,shared=false,media=0;const calls:string[]=[];
 const request:typeof fetch=async(url,init)=>{const parsed=new URL(String(url));calls.push(parsed.pathname+(parsed.searchParams.get('alt')==='media'?':media':''));assert.equal(parsed.origin,'https://www.googleapis.com');assert.equal(init?.method,'GET');
 if(parsed.searchParams.get('alt')==='media'){media++;return new Response('new');}
 const id=parsed.pathname.split('/').at(-1);if(id==='permissions')return Response.json({permissions:[{id:'p',type:'user',role:'reader',emailAddress:'editor@example.org'}]});
 return Response.json({id,mimeType:id==='file'?'text/markdown':'application/vnd.google-apps.folder',version,parents:id==='rootId'?[]:[parent],ownedByMe:owned,shared:id==='file'&&shared,trashed:false,size:'3',capabilities:{canDownload:true}});
 };return {request,calls,change:()=>version='2',move:()=>parent='outside',revoke:()=>owned=false,share:()=>shared=true,media:()=>media};
}
const auth={access:async()=> 'SYNTHETIC',invalidate(){}};
async function collect(source:AsyncIterable<Uint8Array>){let value='';for await(const chunk of source)value+=Buffer.from(chunk).toString();return value;}
test('binary source is verified before IO and after EOF, with a stable bounded fingerprint',async t=>{
 const f=fixture(),reader=new GoogleBinaryReader('rootId',auth,async()=>[],{fetch:f.request});t.after(()=>reader.close());const result=await reader.read('file',allowed);assert.equal(f.media(),0);assert.equal(result.size,3);assert.ok(result.fingerprint.length<=1024);assert.equal(await collect(result.bytes),'new');assert.equal(f.media(),1);assert.equal(f.calls.filter(path=>path.endsWith('/rootId')).length,2);assert.equal(f.calls.filter(path=>path.endsWith('/file')).length,2);
 const again=await reader.read('file',allowed);assert.equal(again.fingerprint,result.fingerprint);await again.bytes[Symbol.asyncIterator]().return?.();
});
test('source version change after bytes cannot be acknowledged as a stable snapshot',async t=>{
 const f=fixture(),reader=new GoogleBinaryReader('rootId',auth,async()=>[],{fetch:f.request});t.after(()=>reader.close());const result=await reader.read('file',allowed),iterator=result.bytes[Symbol.asyncIterator]();assert.equal(Buffer.from((await iterator.next()).value!).toString(),'new');f.change();await assert.rejects(iterator.next(),{code:'PROVIDER_CONFLICT'});
});
test('moved, no-longer-owned and newly unmanaged sources refuse before successful EOF',async t=>{
 for(const change of ['move','revoke','share'] as const){const f=fixture(),reader=new GoogleBinaryReader('rootId',auth,async()=>[],{fetch:f.request});t.after(()=>reader.close());const result=await reader.read('file',allowed),iterator=result.bytes[Symbol.asyncIterator]();await iterator.next();f[change]();await assert.rejects(iterator.next());}
});
test('native MIME never falls through to binary alt=media',async t=>{
 const f=fixture(),request:typeof fetch=async(url,init)=>{const response=await f.request(url,init);if(new URL(String(url)).pathname.endsWith('/file')){const value=await response.json() as any;value.mimeType='application/vnd.google-apps.document';return Response.json(value);}return response;};const reader=new GoogleBinaryReader('rootId',auth,async()=>[],{fetch:request});t.after(()=>reader.close());await assert.rejects(reader.read('file',allowed),{code:'PROVIDER_SOURCE_CHANGED'});assert.equal(f.media(),0);
});
test('one prepared stream cannot be consumed twice and early abandonment does not trigger a second read',async t=>{
 const f=fixture(),reader=new GoogleBinaryReader('rootId',auth,async()=>[],{fetch:f.request});t.after(()=>reader.close());const result=await reader.read('file',allowed);assert.equal(await collect(result.bytes),'new');await assert.rejects(collect(result.bytes),{code:'PROVIDER_SOURCE_CHANGED'});assert.equal(f.media(),1);
});
test('reader close interrupts a pending authority check even before metadata HTTP starts',async()=>{
 const f=fixture(),reader=new GoogleBinaryReader('rootId',auth,async()=>[],{fetch:f.request});let reached!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>reached=r),gate=new Promise<void>(r=>release=r);const pending=reader.read('file',{check:async()=>{reached();await gate;}}),refused=assert.rejects(pending,{code:'PROVIDER_CANCELLED'});await ready;await reader.close();release();await refused;assert.equal(f.calls.length,0);
});
test('closing after preflight prevents the prepared bytes from opening HTTP later',async()=>{
 const f=fixture(),reader=new GoogleBinaryReader('rootId',auth,async()=>[],{fetch:f.request}),result=await reader.read('file',allowed);await reader.close();await assert.rejects(collect(result.bytes),{code:'PROVIDER_CANCELLED'});assert.equal(f.media(),0);
});
