import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowNavigation, registerNavigationGuard } from '../src/navigation-guard.ts';
test('navigation guards block departure and old cleanup cannot remove the current editor guard',()=>{
 assert.equal(allowNavigation(),true);const old=registerNavigationGuard(()=>false);assert.equal(allowNavigation(),false);
 const current=registerNavigationGuard(()=>false);old();assert.equal(allowNavigation(),false);
 current();assert.equal(allowNavigation(),true);
});
