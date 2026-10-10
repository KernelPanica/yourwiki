import test from 'node:test';
import assert from 'node:assert/strict';
import {paginate} from '../../frontend/page-layout.js';

test('page boundaries keep blocks whole and account for paper margins',()=>{
  const result=paginate([{pos:0,height:400},{pos:10,height:400},{pos:20,height:400}],{height:1000,margin:100,gap:20});
  assert.deepEqual(result.breaks,[{pos:20,height:220,page:2}]);
  assert.equal(result.pages,2);assert.equal(result.bottom,500);
});
test('line segments paginate a long paragraph without changing text positions',()=>{
  const result=paginate(Array.from({length:90},(_,i)=>({pos:1+i*12,height:20})),{height:1000,margin:100,gap:20});
  assert.deepEqual(result.breaks.map(item=>item.pos),[481,961]);
  assert.equal(result.pages,3);
});
test('shrinking a document removes obsolete page boundaries',()=>{
  assert.equal(paginate([{pos:0,height:50}]).pages,1);
  assert.deepEqual(paginate([]).breaks,[]);
});
