import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileIcon} from '../../apps/web/src/file-icons.ts';
import {motionEnabled} from '../../apps/web/src/motion.ts';

test('file categories have distinct shapes, normalize formats and fall back safely',()=>{
 const formats=['docx','xlsx','pptx','md','pdf','canvas','drawio','png','zip','ts'];
 assert.equal(new Set(formats.map(format=>fileIcon(format))).size,formats.length);
 assert.equal(fileIcon('DOCX'),'document');
 assert.equal(fileIcon('.XLSX'),'spreadsheet');
 assert.equal(fileIcon(undefined,'Диаграмма.drawio'),'diagram');
 assert.equal(fileIcon(undefined,'Файл без расширения'),'files');
 assert.equal(fileIcon('unknown'),'files');
});
test('motion requires opt in, respects system preference and reads changes immediately',()=>{
 const oldDocument=globalThis.document,oldMatchMedia=globalThis.matchMedia;
 let reduced=false;
 globalThis.document={documentElement:{dataset:{}}};
 globalThis.matchMedia=query=>{assert.equal(query,'(prefers-reduced-motion: reduce)');return {matches:reduced};};
 try{
  assert.equal(motionEnabled(),false);
  document.documentElement.dataset.animations='on';assert.equal(motionEnabled(),true);
  reduced=true;assert.equal(motionEnabled(),false);
  reduced=false;assert.equal(motionEnabled(),true);
  document.documentElement.dataset.animations='off';assert.equal(motionEnabled(),false);
 }finally{globalThis.document=oldDocument;globalThis.matchMedia=oldMatchMedia;}
});
