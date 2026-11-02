import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowNavigation, hasUnsavedChanges, registerNavigationGuard, requestNavigation } from '../src/navigation-guard.ts';
test('navigation guards block departure and old cleanup cannot remove the current editor guard',()=>{
 assert.equal(allowNavigation(),true);const old=registerNavigationGuard(()=>false);assert.equal(allowNavigation(),false);
 const current=registerNavigationGuard(()=>false);old();assert.equal(allowNavigation(),false);
 current();assert.equal(allowNavigation(),true);
});
test('dirty editor detection never prompts and cleanup cannot remove a newer registration of the same function',()=>{
 let prompts=0;const confirm=()=>{prompts++;return false;};
 const old=registerNavigationGuard(confirm,()=>false),current=registerNavigationGuard(confirm,()=>true);
 old();assert.equal(hasUnsavedChanges(),true);assert.equal(prompts,0);
 current();assert.equal(hasUnsavedChanges(),false);
});
test('asynchronous navigation waits for capability release and suppresses concurrent departure',async()=>{
 let release!:(value:boolean)=>void,moves=0,prompts=0;const pending=new Promise<boolean>(resolve=>release=resolve),remove=registerNavigationGuard(()=>{prompts++;return pending;},()=>true);
 const moving=requestNavigation(()=>{moves++;});assert.equal(moves,0);assert.equal(await requestNavigation(()=>{moves+=10;}),false);assert.equal(prompts,1);release(true);assert.equal(await moving,true);assert.equal(moves,1);remove();
});
test('failed or obsolete asynchronous guards cannot unmount another editor',async()=>{
 let release!:(value:boolean)=>void,moves=0;const old=registerNavigationGuard(()=>new Promise<boolean>(resolve=>release=resolve));const moving=requestNavigation(()=>{moves++;});const current=registerNavigationGuard(()=>true);release(true);assert.equal(await moving,false);assert.equal(moves,0);old();current();
 const denied=registerNavigationGuard(async()=>{throw new Error('offline');});assert.equal(await requestNavigation(()=>{moves++;}),false);denied();assert.equal(moves,0);assert.equal(await requestNavigation(()=>{moves++;}),true);assert.equal(moves,1);
});
