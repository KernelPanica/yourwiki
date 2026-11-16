import test from 'node:test';
import assert from 'node:assert/strict';
import {officePresentation} from '../../apps/web/src/office-presentation.ts';
const state=phase=>({phase});
test('opening ends after failure, access revocation and closure even before iframe loaded',()=>{
 for(const phase of ['idle','opening','open'])assert.equal(officePresentation(state(phase),null).loading,true);
 for(const phase of ['failed','paused','closing','closed'])assert.equal(officePresentation(state(phase),null).loading,false);
 assert.equal(officePresentation(state('failed'),null).status,'preview');
 assert.equal(officePresentation(state('paused'),null).status,'stopped');
});
test('save/recovery feedback replaces opening and a failed engine never spins indefinitely',()=>{
 assert.equal(officePresentation(state('open'),{loaded:true,saving:true}).status,'saving');
 assert.equal(officePresentation(state('open'),{loaded:true,phase:'saved'}).status,'saved');
 assert.equal(officePresentation(state('open'),{loaded:true,needsRecovery:true}).status,'modified');
 assert.equal(officePresentation(state('open'),{loaded:false,phase:'failed'}).loading,false);
 assert.equal(officePresentation(state('open'),{loaded:true}).status,'ready');
});
