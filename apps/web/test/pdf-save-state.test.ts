import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PdfSaveState } from '../src/pdf-save-state.ts';
test('PDF save receipts acknowledge only the edits actually included in the save',()=>{
 const state=new PdfSaveState(3,7);state.changed();const first=state.begin()!;
 assert.equal(state.begin(),null);state.changed();state.complete(first,{baseRevision:3,layerRevision:8});
 assert.equal(state.dirty,true);const second=state.begin()!;
 state.complete(second,{baseRevision:3,layerRevision:9});assert.equal(state.dirty,false);
});
test('uncertain PDF saves pause instead of silently replaying or acknowledging edits',()=>{
 const state=new PdfSaveState(1,0);state.changed();const snapshot=state.begin()!;
 assert.throws(()=>state.complete(snapshot,{baseRevision:1,layerRevision:3}),/INVALID_SAVE_RECEIPT/);
 assert.equal(state.dirty,true);assert.equal(state.begin(),null);
});
test('PDF remote changes require reload when clean, and preserve dirty edits on conflict',()=>{
 const state=new PdfSaveState(1,0);assert.equal(state.remote(1,0),'unchanged');
 state.changed();assert.equal(state.remote(2,0),'conflict');assert.equal(state.dirty,true);assert.equal(state.begin(),null);
 const clean=new PdfSaveState(1,0);assert.equal(clean.remote(1,1),'reload');
});
test('failed PDF saves retain dirty state and do not start automatic retries',()=>{
 const state=new PdfSaveState(1,0);state.changed();assert.ok(state.begin());state.fail();
 assert.equal(state.dirty,true);assert.equal(state.saving,false);assert.equal(state.begin(),null);
});
