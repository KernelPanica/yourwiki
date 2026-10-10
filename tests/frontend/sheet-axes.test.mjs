import test from 'node:test';
import assert from 'node:assert/strict';
import {updateAxes} from '../../frontend/sheet-axes.js';

test('insert and remove keep existing row identities',()=>{
  const layout={s:{rows:{r0:0,r1:1,r2:2},cols:{c0:0}}};
  updateAxes(layout,'sheet.mutation.insert-row',{subUnitId:'s',range:{startRow:1,endRow:1}},()=> 'new');
  assert.deepEqual(Object.keys(layout.s.rows).sort((a,b)=>layout.s.rows[a]-layout.s.rows[b]),['r0','new','r1','r2']);
  updateAxes(layout,'sheet.mutation.remove-rows',{subUnitId:'s',range:{startRow:2,endRow:2}});
  assert.equal(layout.s.rows.r1,undefined);
  assert.ok('r2' in layout.s.rows);
});

test('move rows uses pre-move destination and preserves IDs',()=>{
  const layout={s:{rows:{a:0,b:1,c:2,d:3},cols:{x:0}}};
  updateAxes(layout,'sheet.mutation.move-rows',{subUnitId:'s',sourceRange:{startRow:1,endRow:2},targetRange:{startRow:4}});
  assert.deepEqual(Object.keys(layout.s.rows).sort((a,b)=>layout.s.rows[a]-layout.s.rows[b]),['a','d','b','c']);
});

test('move columns to the start',()=>{
  const layout={s:{rows:{a:0},cols:{x:0,y:1,z:2}}};
  updateAxes(layout,'sheet.mutation.move-columns',{subUnitId:'s',sourceRange:{startColumn:2,endColumn:2},targetRange:{startColumn:0}});
  assert.deepEqual(Object.keys(layout.s.cols).sort((a,b)=>layout.s.cols[a]-layout.s.cols[b]),['z','x','y']);
});

test('undo history distinguishes a new insertion from an older deletion at the same position',async()=>{
  const {createAxisHistory}=await import('../../frontend/sheet-axes.js');
  let layout={s:{rows:{a:0,b:1,c:2},cols:{x:0}}},topUndo,topRedo;
  const history=createAxisHistory({read:()=>layout,write:value=>{layout=value;},undo:()=>topUndo,redo:()=>topRedo});
  const command={id:'sheet.command.edit',type:0};
  history.before(command);
  history.mutate(()=>updateAxes(layout,'sheet.mutation.remove-rows',{subUnitId:'s',range:{startRow:1,endRow:1}}));
  const deletion=topUndo={};history.after(command);
  history.before(command);
  history.mutate(()=>updateAxes(layout,'sheet.mutation.insert-row',{subUnitId:'s',range:{startRow:1,endRow:1}},()=> 'fresh'));
  const insertion=topUndo={};history.after(command);
  const undo={id:'univer.command.undo',type:0};
  history.before(undo);topRedo=insertion;topUndo=deletion;history.after(undo);
  assert.deepEqual(Object.keys(layout.s.rows),['a','c']);
  history.before(undo);topRedo=deletion;topUndo=null;history.after(undo);
  assert.deepEqual(layout.s.rows,{a:0,b:1,c:2});
});
