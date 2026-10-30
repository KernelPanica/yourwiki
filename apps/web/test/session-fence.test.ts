import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockSession,resumeSession,sessionSnapshot,sessionIsCurrent,onSessionBlocked } from '../src/session-fence.ts';
test('blocking a session invalidates pending work synchronously and only explicit resume permits new work',()=>{
 resumeSession();const first=sessionSnapshot();let calls=0;const stop=onSessionBlocked(()=>calls++);
 blockSession();assert.equal(first.signal.aborted,true);assert.equal(sessionIsCurrent(first.generation),false);assert.equal(calls,1);
 const blocked=sessionSnapshot();assert.equal(blocked.blocked,true);blockSession();assert.notEqual(sessionSnapshot().generation,blocked.generation);
 resumeSession();const current=sessionSnapshot();assert.equal(current.blocked,false);assert.equal(sessionIsCurrent(current.generation),true);
 stop();blockSession();assert.equal(calls,2);resumeSession();
});
test('one broken editor listener cannot leave other editors unfenced',()=>{
 resumeSession();const stopBroken=onSessionBlocked(()=>{throw new Error('Broken UI');});let blocked=false;
 const stopGood=onSessionBlocked(()=>{blocked=true;});blockSession();assert.equal(blocked,true);stopBroken();stopGood();resumeSession();
});
