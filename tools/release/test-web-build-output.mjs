import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {retainPreviousAssets,publishBuild,recoverBuild} from '../../apps/web/build-output.mjs';

test('three releases retain exactly current and previous assets, including lazy chunks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'wiki-build-')),dist=join(root,'dist');
 try{
  for(const release of ['a','b','c']){
   const stage=join(root,'stage');await mkdir(join(stage,'assets'),{recursive:true});
   const currentAssets=Object.fromEntries([release+'.js','lazy-'+release+'.js'].map(name=>[name,{size:1}]));
   for(const name of Object.keys(currentAssets))for(const suffix of ['','.gz','.br'])await writeFile(join(stage,'assets',name+suffix),release);
   const assets=await retainPreviousAssets(dist,stage,currentAssets);
   await writeFile(join(stage,'manifest.json'),JSON.stringify({assets,currentAssets}));
   await publishBuild(stage,dist);
  }
  const manifest=JSON.parse(await readFile(join(dist,'manifest.json'),'utf8'));
  assert.deepEqual(Object.keys(manifest.assets).sort(),['b.js','c.js','lazy-b.js','lazy-c.js']);
  assert(!(await readdir(join(dist,'assets'))).some(name=>name.includes('a.')));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('failed publication restores the last working build',async()=>{
 const root=await mkdtemp(join(tmpdir(),'wiki-build-')),dist=join(root,'dist');
 try{await mkdir(dist);await writeFile(join(dist,'index.html'),'working');await assert.rejects(publishBuild(join(root,'missing'),dist));assert.equal(await readFile(join(dist,'index.html'),'utf8'),'working');}
 finally{await rm(root,{recursive:true,force:true});}
});

test('an interrupted directory swap is recovered automatically on the next build',async()=>{
 const root=await mkdtemp(join(tmpdir(),'wiki-build-')),dist=join(root,'dist');
 try{await mkdir(dist+'.previous');await writeFile(join(dist+'.previous','index.html'),'working');await recoverBuild(dist);assert.equal(await readFile(join(dist,'index.html'),'utf8'),'working');}
 finally{await rm(root,{recursive:true,force:true});}
});
