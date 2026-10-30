import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serializePdf } from '../src/pdf-serialization.ts';
import { PdfSaveState } from '../src/pdf-save-state.ts';
test('serialization hash catches a second mutation without a second modified callback',async()=>{
 const state=new PdfSaveState(1,0);state.changed();const snapshot=state.begin()!;
 let hash='one',release!:(bytes:Uint8Array)=>void;
 const pdf={annotationStorage:{get serializable(){return {hash};}},saveDocument:()=>new Promise<Uint8Array>(resolve=>{release=resolve;})};
 const pending=serializePdf(pdf,()=>state.changed());hash='two';release(new Uint8Array([1]));await pending;
 state.complete(snapshot,{baseRevision:1,layerRevision:1});assert.equal(state.dirty,true);assert.ok(state.begin());
});
test('unchanged serialized storage does not create redundant saves',async()=>{
 let calls=0;await serializePdf({annotationStorage:{serializable:{hash:'same'}},saveDocument:async()=>new Uint8Array()},()=>calls++);assert.equal(calls,0);
});
