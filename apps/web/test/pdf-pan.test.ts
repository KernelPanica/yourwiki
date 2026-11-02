import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PdfPan } from '../src/pdf-pan.ts';
const bounds={left:10,top:20,width:300,height:400,scrollLeft:40,scrollTop:80};
const mouse={id:1,x:100,y:200,button:0,type:'mouse'};
test('PDF mouse panning moves both scroll axes and keeps the first captured pointer',()=>{
 const pan=new PdfPan();assert.equal(pan.begin(mouse,bounds),true);
 assert.equal(pan.begin({...mouse,id:2},bounds),false);
 assert.deepEqual(pan.move({id:1,x:75,y:150}),{left:65,top:130});
 assert.equal(pan.move({id:2,x:75,y:150}),null);assert.equal(pan.end(2),false);
 assert.equal(pan.end(1),true);assert.equal(pan.move(mouse),null);
});
test('PDF panning leaves touch scrolling, scrollbar clicks and non-primary buttons native',()=>{
 for(const input of [{...mouse,type:'touch'},{...mouse,button:1},{...mouse,x:310},{...mouse,y:420}])assert.equal(new PdfPan().begin(input,bounds),false);
});
