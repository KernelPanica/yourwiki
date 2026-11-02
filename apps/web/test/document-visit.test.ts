import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DocumentVisit} from '../src/document-visit.ts';
import {blockSession,resumeSession} from '../src/session-fence.ts';
import {ApiError} from '../src/api.ts';
const tick=()=>new Promise<void>(resolve=>queueMicrotask(resolve));
test('document opening records once despite view refreshes, without waiting to render',async()=>{
 resumeSession();let finish!:(value:unknown)=>void;const requests:{url:string;init:RequestInit}[]=[];const visit=new DocumentVisit({documentId:'doc /1',csrf:'proof',request:async(url,init)=>{requests.push({url,init});return new Promise(resolve=>{finish=resolve;});}});const first=visit.opened();assert.equal(visit.snapshot().phase,'pending');void visit.opened();assert.equal(requests.length,1);assert.equal(requests[0].url,'/api/documents/doc%20%2F1/visit');assert.equal(requests[0].init.method,'POST');assert.equal((requests[0].init.headers as Record<string,string>)['x-csrf-token'],'proof');finish(undefined);await first;assert.equal(visit.snapshot().phase,'saved');await visit.opened();assert.equal(requests.length,1);visit.dispose();
});
test('failed visit keeps explicit retry available and never retries during view refresh',async()=>{
 resumeSession();let calls=0;const visit=new DocumentVisit({documentId:'doc',csrf:'proof',request:async()=>{calls++;if(calls===1)throw new ApiError('REQUEST_FAILED');return undefined;}});await visit.opened();assert.equal(visit.snapshot().phase,'error');await visit.opened();assert.equal(calls,1);await visit.retry();assert.equal(calls,2);assert.equal(visit.snapshot().phase,'saved');visit.dispose();
});
test('invalid acknowledgement is uncertain and needs explicit retry rather than claiming a recorded visit',async()=>{
 resumeSession();const visit=new DocumentVisit({documentId:'doc',csrf:'proof',request:async()=>({ok:true})});await visit.opened();assert.equal(visit.snapshot().phase,'error');visit.dispose();
});
test('disposed or account-fenced visit ignores late replies and cannot record under another account',async()=>{
 for(const action of ['dispose','block'] as const){resumeSession();let finish!:(value:unknown)=>void,calls=0,updates=0,signal:AbortSignal|undefined;const visit=new DocumentVisit({documentId:'doc',csrf:'proof',changed:()=>{updates++;},request:async(_url,init)=>{calls++;signal=init.signal as AbortSignal;return new Promise(resolve=>{finish=resolve;});}});const task=visit.opened();if(action==='dispose')visit.dispose();else blockSession();const before=updates;assert.equal(signal!.aborted,action==='block');resumeSession();finish(undefined);await task;await tick();assert.equal(updates,before);await visit.opened();await visit.retry();assert.equal(calls,1);visit.dispose();}
});

test('leaving the page lets its bounded visit finish and refresh Recent without updating disposed UI',async()=>{
 resumeSession();let finish!:(value:unknown)=>void,updates=0,recorded=0,signal:AbortSignal|undefined;const visit=new DocumentVisit({documentId:'doc',csrf:'proof',changed:()=>{updates++;},recorded:()=>{recorded++;},request:async(_url,init)=>{signal=init.signal as AbortSignal;return new Promise(resolve=>{finish=resolve;});}});const pending=visit.opened();visit.dispose();const before=updates;assert.equal(signal!.aborted,false);finish(undefined);await pending;assert.equal(recorded,1);assert.equal(updates,before);
});
