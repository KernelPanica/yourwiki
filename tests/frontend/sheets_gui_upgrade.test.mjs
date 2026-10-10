import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalFormula,displayFormula,normalizeFormulaCells,availableFunctions,russianFunctions} from '../../frontend/sheet-formulas.js';

test('Russian formulas and nested semicolon arguments become portable engine formulas',()=>{
  assert.equal(canonicalFormula('=ЕСЛИ(СУММ(A1:A3)>0;ОКРУГЛ(СРЗНАЧ(B1:B3);2);"Пусто")'),'=IF(SUM(A1:A3)>0,ROUND(AVERAGE(B1:B3),2),"Пусто")');
  assert.equal(canonicalFormula('=счетесли(A1:A4;">0")'),'=COUNTIF(A1:A4,">0")');
  assert.equal(displayFormula('=IF(SUM(A1:A3)>0,ROUND(AVERAGE(B1:B3),2),"Пусто")'),'=ЕСЛИ(СУММ(A1:A3)>0;ОКРУГЛ(СРЗНАЧ(B1:B3);2);"Пусто")');
});
test('quoted text, escaped quotes, sheet names, arrays and structured references are untouched',()=>{
  const formula='=ЕСЛИ(\'СУММ(; чужой\'\' лист\'!A1>0;"ЕСЛИ(A1;""да"")";СУММ({1,2;3,4}))';
  const canonical='=IF(\'СУММ(; чужой\'\' лист\'!A1>0,"ЕСЛИ(A1;""да"")",SUM({1,2;3,4}))';
  assert.equal(canonicalFormula(formula),canonical);
  assert.equal(displayFormula(canonical),formula);
  assert.equal(canonicalFormula('=СУММ(Table[ЕСЛИ(;)];A1)'),'=SUM(Table[ЕСЛИ(;)],A1)');
  assert.equal(canonicalFormula('=СУММ!A1+1'),'=СУММ!A1+1');
});
test('English input and decimal point numbers work, unknown names remain engine errors',()=>{
  assert.equal(canonicalFormula('=ROUND(1.25;1)'),'=ROUND(1.25,1)');
  assert.equal(canonicalFormula('=SUM(1,2)'),'=SUM(1,2)');
  assert.equal(canonicalFormula('=НЕИЗВЕСТНО(A1;2)'),'=НЕИЗВЕСТНО(A1,2)');
  assert.equal(displayFormula('=SUM(A1,A2)',false),'=SUM(A1,A2)');
  for(const value of [null,123,'СУММ(A1)','="СУММ(A1;A2)"'])assert.equal(canonicalFormula(value),value);
});
test('all declared Russian aliases round trip without collisions',()=>{
  for(const [name,local] of Object.entries(russianFunctions)){
    assert.equal(canonicalFormula(`=${local}(A1;B2)`),`=${name}(A1,B2)`);
    assert.equal(displayFormula(`=${name}(A1,B2)`),`=${local}(A1;B2)`);
  }
});
test('mutation normalization preserves text, formatting, cached values and stable IDs',()=>{
  const matrix={rStable:{cStable:{f:'=СУММ(A1;B1)',v:4,s:'style'},cText:{v:'=СУММ(A1;B1)',t:1}},rEmpty:null};
  normalizeFormulaCells(matrix);
  assert.deepEqual(matrix,{rStable:{cStable:{f:'=SUM(A1,B1)',v:4,s:'style'},cText:{v:'=СУММ(A1;B1)',t:1}},rEmpty:null});
});
test('function picker lists only registered executors and excludes server-blocked external functions',()=>{
  const service={getExecutors:()=>new Map([['SUM',{}],['IF',{}],['UNIMPLEMENTED',{}],['HYPERLINK',{}],['WEBSERVICE',{}]]),getDescription:name=>({abstract:name})};
  assert.deepEqual(availableFunctions(service).map(({name,localName})=>[name,localName]),[['IF','ЕСЛИ'],['SUM','СУММ'],['UNIMPLEMENTED','UNIMPLEMENTED']]);
});

test('formula-bar values preserve numeric, boolean, text and empty cell semantics',async()=>{
  const {sheetInputValue}=await import('../../frontend/sheet-formulas.js');
  assert.equal(sheetInputValue('10'),10);assert.equal(sheetInputValue('-1.25'),-1.25);assert.equal(sheetInputValue('1e3'),1000);
  assert.equal(sheetInputValue('ИСТИНА'),true);assert.equal(sheetInputValue('FALSE'),false);
  assert.deepEqual(sheetInputValue('0010',true),{v:'0010',t:1,f:null,p:null});
  assert.deepEqual(sheetInputValue("'=СУММ(A1)"),{v:'=СУММ(A1)',t:1,f:null,p:null});
  assert.deepEqual(sheetInputValue(''),{v:null,f:null,p:null});
  assert.deepEqual(sheetInputValue('=СУММ(A1;A2)'),{f:'=SUM(A1,A2)',v:null,p:null});
});

test('aliases refer to real Univer executors and engine computes SUM, IF, ROUND and text',async()=>{
  const {ALL_IMPLEMENTED_FUNCTIONS,NumberValueObject,StringValueObject,BooleanValueObject}=await import('@univerjs/engine-formula');
  const functions=new Map(ALL_IMPLEMENTED_FUNCTIONS.map(([Executor,name])=>[name,new Executor(name)]));
  for(const name of Object.keys(russianFunctions))assert.ok(functions.has(name),`${name} alias must refer to an implemented function`);
  for(const name of ['SUM','IF','ROUND','AVERAGE','COUNTIF','VLOOKUP','TODAY','CONCATENATE'])assert.ok(functions.has(name),`${name} must be implemented`);
  const number=value=>NumberValueObject.create(value);
  assert.equal(functions.get('SUM').calculate(number(10),number(20)).getValue(),30);
  assert.equal(functions.get('ROUND').calculate(number(1.25),number(1)).getValue(),1.3);
  assert.equal(functions.get('IF').calculate(BooleanValueObject.create(true),number(10),number(20)).getValue(),10);
  assert.equal(functions.get('CONCATENATE').calculate(StringValueObject.create('Привет'),StringValueObject.create(' мир')).get(0,0).getValue(),'Привет мир');
});
