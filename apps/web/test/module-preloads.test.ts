import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modulePreloads} from '../module-preloads.ts';
test('HTML preloads the transitive static entry graph once without fetching optional editors',()=>{
 const outputs={
  'dist/assets/main-ONE.js':{imports:[{path:'dist/assets/shared-A.js',kind:'import-statement'},{path:'dist/assets/shared-B.js',kind:'import-statement'},{path:'dist/assets/pdf-LARGE.js',kind:'dynamic-import'}]},
  'dist/assets/shared-A.js':{imports:[{path:'dist/assets/common-C.js',kind:'import-statement'}]},
  'dist/assets/shared-B.js':{imports:[{path:'dist/assets/common-C.js',kind:'import-statement'},{path:'https://cdn.invalid/remote.js',kind:'import-statement',external:true},{path:'dist/assets/theme.css',kind:'import-statement'}]},
  'dist/assets/common-C.js':{imports:[{path:'dist/assets/shared-A.js',kind:'import-statement'}]},
  'dist/assets/pdf-LARGE.js':{imports:[{path:'dist/assets/pdf-dependency.js',kind:'import-statement'}]},
  'dist/assets/pdf-dependency.js':{imports:[]}
 };assert.deepEqual(modulePreloads(outputs,'dist/assets/main-ONE.js'),['shared-A.js','common-C.js','shared-B.js']);
});
test('missing static build outputs fail instead of silently retaining a request waterfall',()=>{
 assert.throws(()=>modulePreloads({'dist/assets/main.js':{imports:[{path:'dist/assets/missing.js',kind:'import-statement'}]}},'dist/assets/main.js'),/Missing/);assert.throws(()=>modulePreloads({},'dist/assets/main.js'),/Missing/);
});
