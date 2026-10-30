import assert from 'node:assert/strict';
import { test } from 'node:test';
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
