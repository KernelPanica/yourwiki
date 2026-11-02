import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slidesFor,nextSlide } from '../src/presentation-model.ts';
import { assetUrl } from '../src/api.ts';
import type { DocumentView } from '../src/api.ts';
const view:DocumentView={document:{id:'doc',title:'Slides',format:'pptx',revision:1,manifestDigest:'a'.repeat(64),capabilities:{write:false,export:false}},manifest:{kind:'presentation',primary:'content',artifacts:[{name:'slide-1.png',digest:'b'.repeat(64),size:1,mimeType:'image/png'},{name:'thumb-1.png',digest:'c'.repeat(64),size:1,mimeType:'image/png'}]},presentation:{schemaVersion:1,slides:[{index:1,image:'slide-1.png',thumbnail:'thumb-1.png'}]}};
test('presentation indices must reference ordered published image artifacts',()=>{
 assert.equal(slidesFor(view).length,1);
 assert.throws(()=>slidesFor({...view,presentation:{schemaVersion:1,slides:[{index:1,image:'https://evil.test/x',thumbnail:'thumb-1.png'}]}}),/INVALID_PREVIEW/);
 assert.throws(()=>assetUrl(view,'missing'),/INVALID_PREVIEW/);
});
test('keyboard moves predictably and stays within slide boundaries',()=>{
 assert.equal(nextSlide(0,'ArrowLeft',3),0);assert.equal(nextSlide(0,'ArrowRight',3),1);
 assert.equal(nextSlide(2,'PageDown',3),2);assert.equal(nextSlide(2,'Home',3),0);assert.equal(nextSlide(0,'End',3),2);
});
