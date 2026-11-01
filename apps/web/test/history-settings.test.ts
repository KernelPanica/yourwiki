import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HistorySettingsClient,parseHistorySettings} from '../src/history-settings.ts';
import {ApiError} from '../src/api.ts';
import {resumeSession,blockSession} from '../src/session-fence.ts';
const initial={enabled:false,revision:0,byteLimit:42949672960,entryLimit:100000};
function setup(t:any,request:(url:string,init?:RequestInit)=>Promise<unknown>){resumeSession();const client=new HistorySettingsClient({csrf:'csrf',request});t.after(()=>client.dispose());return client;}
test('settings use validated copied authoritative metadata and CAS/CSRF only after explicit input',async t=>{
 const calls:any[]=[],client=setup(t,async(url,init)=>{calls.push({url,init});return init?.method==='PUT'?{...initial,enabled:true,revision:1}:initial;});await client.load();assert.equal(calls.length,1);const copy=client.snapshot();copy.value!.enabled=true;assert.equal(client.snapshot().value!.enabled,false);await client.setEnabled(true);assert.equal(client.snapshot().phase,'saved');assert.equal(client.snapshot().value!.enabled,true);assert.deepEqual(JSON.parse(calls[1].init.body),{enabled:true,baseRevision:0});assert.equal(calls[1].init.headers['x-csrf-token'],'csrf');assert.equal(initial.enabled,false);for(const value of [{...initial,enabled:1},{...initial,revision:-1},{...initial,entryLimit:0},{...initial,byteLimit:Infinity}])assert.throws(()=>parseHistorySettings(value),/INVALID_HISTORY_SETTINGS/);
});
test('lost write acknowledgement reads back success without replaying a PUT',async t=>{
 let saved=false,puts=0;const client=setup(t,async(_url,init)=>{if(init?.method==='PUT'){puts++;saved=true;throw new Error('reply lost');}return {...initial,enabled:saved,revision:saved?1:0};});await client.load();await client.setEnabled(true);assert.equal(puts,1);assert.equal(client.snapshot().phase,'saved');assert.equal(client.snapshot().value!.enabled,true);
});
test('uncertain differing state requires explicit retry and a fresh authoritative baseline',async t=>{
 let puts=0;const bodies:any[]=[],client=setup(t,async(_url,init)=>{if(init?.method==='PUT'){puts++;bodies.push(JSON.parse(String(init.body)));if(puts===1)throw new Error('network');return {...initial,enabled:true,revision:3};}return {...initial,revision:puts?2:0};});await client.load();await client.setEnabled(true);assert.equal(puts,1);assert.equal(client.snapshot().phase,'unknown');assert.equal(client.snapshot().value!.revision,2);await client.retry();assert.equal(puts,2);assert.deepEqual(bodies[1],{enabled:true,baseRevision:2});assert.equal(client.snapshot().phase,'saved');
});
test('CAS conflict retains intent and reports fresh actual state without automatic replay',async t=>{
 let puts=0;const client=setup(t,async(_url,init)=>{if(init?.method==='PUT'){puts++;throw new ApiError('CONFLICT');}return {...initial,revision:puts?2:0};});await client.load();await client.setEnabled(true);assert.equal(puts,1);assert.equal(client.snapshot().phase,'conflict');assert.equal(client.snapshot().desired,true);assert.equal(client.snapshot().value!.enabled,false);await client.load();assert.equal(puts,1);assert.equal(client.snapshot().phase,'ready');assert.equal(client.snapshot().desired,false);
});
test('failed read-back never retries a write automatically and an explicit retry needs a readable baseline',async t=>{
 let calls=0,puts=0;const client=setup(t,async(_url,init)=>{calls++;if(init?.method==='PUT'){puts++;throw new Error('network');}if(calls>1)throw new Error('offline');return initial;});await client.load();await client.setEnabled(true);assert.equal(client.snapshot().phase,'unknown');await client.retry();assert.equal(puts,1);assert.equal(client.snapshot().phase,'unknown');
});
test('single-flight writes and late account replies cannot restore old settings or replay mutations',async t=>{
 let resolve!:(value:unknown)=>void,puts=0;const pending=new Promise<unknown>(r=>resolve=r),client=setup(t,async(_url,init)=>{if(init?.method==='PUT'){puts++;return pending;}return initial;});await client.load();const writing=client.setEnabled(true);await client.setEnabled(false);assert.equal(puts,1);blockSession();resolve({...initial,enabled:true,revision:1});await writing;assert.equal(client.snapshot().phase,'blocked');assert.equal(client.snapshot().value,null);resumeSession();assert.equal(client.snapshot().value,null);assert.equal(puts,1);
});
test('denied settings are cleared and cannot be changed from stale metadata',async t=>{
 let denied=false,puts=0;const client=setup(t,async(_url,init)=>{if(init?.method==='PUT')puts++;if(denied)throw new ApiError('ACCESS_DENIED');return initial;});await client.load();denied=true;await client.setEnabled(true);assert.equal(client.snapshot().value,null);assert.equal(client.snapshot().errorCode,'ACCESS_DENIED');await client.setEnabled(false);assert.equal(puts,1);
});
