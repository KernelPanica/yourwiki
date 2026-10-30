import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { gzipSync,brotliCompressSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/app.ts';
test('web shell serves only manifest assets with immutable code/font cache and safe document routes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'yourwiki-web-'));await mkdir(join(root,'assets'));
 const source=Buffer.from('console.log("public code")'),gzip=gzipSync(source),br=brotliCompressSync(source);
 await writeFile(join(root,'index.html'),'<html>Yourwiki</html>');
 await writeFile(join(root,'manifest.json'),JSON.stringify({assets:{'main-ABC.js':{type:'text/javascript',size:source.length,gzipSize:gzip.length,brSize:br.length}}}));
 for(const [name,content] of [['main-ABC.js',source],['main-ABC.js.gz',gzip],['main-ABC.js.br',br]] as const)await writeFile(join(root,'assets',name),content);
 const app=buildApp({webRoot:root});t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const page=await app.inject({url:'/documents/private-id'});assert.equal(page.statusCode,200);assert.equal(page.headers['cache-control'],'no-store');assert.match(page.headers['content-security-policy'] as string,/script-src 'self'/);
 const asset=await app.inject({url:'/assets/main-ABC.js',headers:{'accept-encoding':'br'}});assert.equal(asset.statusCode,200);assert.equal(asset.headers['content-encoding'],'br');assert.match(asset.headers['cache-control'] as string,/immutable/);assert.deepEqual(asset.rawPayload,br);
 const plain=await app.inject({url:'/assets/main-ABC.js',headers:{'accept-encoding':'br;q=0,gzip;q=0'}});assert.equal(plain.headers['content-encoding'],undefined);assert.equal(plain.body,source.toString());
 assert.equal((await app.inject({url:'/assets/manifest.json'})).statusCode,404);
 assert.equal((await app.inject({url:'/api/unknown'})).statusCode,404);
});
test('PDF worker resources use immutable version paths and never arbitrary filesystem paths',async t=>{
 const root=await mkdtemp(join(tmpdir(),'yourwiki-pdf-assets-'));
 const name='pdf-a1b2c3d4e5f60123/cmaps/Example.bcmap',source=Buffer.from('public cmap'),gzip=gzipSync(source),br=brotliCompressSync(source);
 await mkdir(join(root,'assets','pdf-a1b2c3d4e5f60123','cmaps'),{recursive:true});
 await writeFile(join(root,'index.html'),'<html>PDF</html>');
 await writeFile(join(root,'manifest.json'),JSON.stringify({assets:{[name]:{type:'application/octet-stream',size:source.length,gzipSize:gzip.length,brSize:br.length}}}));
 for(const [suffix,content] of [['',source],['.gz',gzip],['.br',br]] as const)await writeFile(join(root,'assets',name+suffix),content);
 const app=buildApp({webRoot:root});t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const result=await app.inject({url:'/assets/'+name});assert.equal(result.statusCode,200);assert.equal(result.body,'public cmap');
 assert.match(result.headers['cache-control'] as string,/immutable/);
 assert.equal((await app.inject({url:'/assets/pdf-a1b2c3d4e5f60123/cmaps/unknown.bcmap'})).statusCode,404);
});
test('configured office origin is scoped to frames and form submission without expanding script permissions',async t=>{
 const root=await mkdtemp(join(tmpdir(),'yourwiki-office-shell-'));await writeFile(join(root,'index.html'),'<html>Office</html>');await writeFile(join(root,'manifest.json'),JSON.stringify({assets:{}}));const app=buildApp({webRoot:root,office:{publicUrl:'https://office.example.test/collabora'}});t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});const page=await app.inject({url:'/'}),csp=page.headers['content-security-policy'] as string;assert.match(csp,/frame-src 'self' https:\/\/office.example.test;/);assert.match(csp,/form-action 'self' https:\/\/office.example.test;/);assert.match(csp,/script-src 'self';/);assert.doesNotMatch(csp,/unsafe-eval|wasm-unsafe-eval|\*/);
});
