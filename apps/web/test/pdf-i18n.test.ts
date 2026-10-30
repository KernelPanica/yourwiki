import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pdfLabels } from '../src/pdf-i18n.ts';
test('PDF controls and recovery warnings are available in every supported interface language',()=>{
 assert.equal(pdfLabels.en.save,'Save');assert.equal(pdfLabels.ru.save,'Сохранить');
 for(const language of ['ru','en','es'] as const){
  assert.deepEqual(Object.keys(pdfLabels[language]).sort(),Object.keys(pdfLabels.en).sort());
  assert.ok(Object.values(pdfLabels[language]).every(value=>value.trim().length>0));
 }
 assert.match(pdfLabels.en.uncertain,/not confirmed/i);assert.match(pdfLabels.en.leave,/without saving/i);
});
