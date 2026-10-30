import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockSession,resumeSession } from '../src/session-fence.ts';
import { api } from '../src/api.ts';
test('late JSON from an aborted request cannot restore stale session data',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 let release!:(value:unknown)=>void;
 const body=new Promise(resolve=>{release=resolve;});
 globalThis.fetch=(async()=>({ok:true,status:200,json:()=>body}) as Response) as typeof fetch;
 const controller=new AbortController();
 const request=api('/api/account',{signal:controller.signal});
 await Promise.resolve();controller.abort();release({user:{id:'old-user'}});
 await assert.rejects(request,(error:any)=>error.name==='AbortError');
});
test('session changes fence late JSON and block private requests before fetch while permitting account recovery',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;resumeSession();});resumeSession();
 let release!:(value:unknown)=>void,calls=0;const body=new Promise(resolve=>{release=resolve;});
 globalThis.fetch=(async()=>{calls++;return {ok:true,status:200,json:()=>body} as Response;}) as typeof fetch;
 const pending=api('/api/documents/id/view');await Promise.resolve();blockSession();release({private:'old account'});
 await assert.rejects(pending,(error:any)=>error.code==='SESSION_REQUIRED');
 await assert.rejects(api('/api/documents'),(error:any)=>error.code==='SESSION_REQUIRED');assert.equal(calls,1);
 globalThis.fetch=(async()=>({ok:true,status:200,json:async()=>({user:{id:'new'}})}) as Response) as typeof fetch;
 assert.deepEqual(await api('/api/account'),{user:{id:'new'}});
});
test('a blocked session permits only the exact office revocation control, never other office APIs',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;resumeSession();});resumeSession();blockSession();const calls:string[]=[];globalThis.fetch=(async url=>{calls.push(String(url));return new Response(null,{status:204});}) as typeof fetch;
 await api('/api/auth/office-revoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:'room',accessToken:'a'.repeat(43)})});assert.deepEqual(calls,['/api/auth/office-revoke']);for(const url of ['/api/auth/office-revoke-extra','/api/auth/office-revoke/anything','/api/office/room/status','/api/documents'])await assert.rejects(api(url),(e:any)=>e.code==='SESSION_REQUIRED');assert.equal(calls.length,1);
});
