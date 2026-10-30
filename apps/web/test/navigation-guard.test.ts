import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowNavigation, hasUnsavedChanges, registerNavigationGuard } from '../src/navigation-guard.ts';
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
