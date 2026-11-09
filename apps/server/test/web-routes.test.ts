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
 const recent=await app.inject({url:'/recent'});assert.equal(recent.statusCode,200);assert.equal(recent.headers['cache-control'],'no-store');assert.equal(recent.body,'<html>Yourwiki</html>');
 const settings=await app.inject({url:'/settings'});assert.equal(settings.statusCode,200);assert.equal(settings.headers['cache-control'],'no-store');assert.equal(settings.body,'<html>Yourwiki</html>');
 for(const url of ['/dashboard','/folders/folder-id','/invite']){const direct=await app.inject({url});assert.equal(direct.statusCode,200,url);assert.equal(direct.body,'<html>Yourwiki</html>');}
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

test('dynamic editor styles receive a fresh matching nonce without allowing inline scripts',async t=>{const root=await mkdtemp(join(tmpdir(),'yourwiki-editor-csp-'));await writeFile(join(root,'index.html'),'<html><head></head><body></body></html>');await writeFile(join(root,'manifest.json'),JSON.stringify({assets:{}}));const app=buildApp({webRoot:root});t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});const first=await app.inject({url:'/'}),second=await app.inject({url:'/'}),nonce=(body:string)=>/name="yourwiki-style-nonce" content="([^"]+)"/.exec(body)![1];assert.notEqual(nonce(first.body),nonce(second.body));assert((first.headers['content-security-policy'] as string).includes("'nonce-"+nonce(first.body)+"'"));assert.match(first.headers['content-security-policy'] as string,/script-src 'self';/);assert.doesNotMatch(first.headers['content-security-policy'] as string,/script-src[^;]*(unsafe-inline|unsafe-eval)/);});

test('legacy favicon is served with the correct MIME type and conventional icon routes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'yourwiki-favicon-'));await mkdir(join(root,'assets'));
 const assets:Record<string,unknown>={},favicon={svg:'favicon-1234.svg',ico:'favicon-5678.ico'};
 for(const [extension,name] of Object.entries(favicon)){const source=extension==='svg'?Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'):Buffer.from([0,0,1,0]),gzip=gzipSync(source),br=brotliCompressSync(source);assets[name]={type:extension==='svg'?'image/svg+xml':'image/x-icon',size:source.length,gzipSize:gzip.length,brSize:br.length};for(const [suffix,data] of [['',source],['.gz',gzip],['.br',br]] as const)await writeFile(join(root,'assets',name+suffix),data);}
 await writeFile(join(root,'index.html'),'<html>Icons</html>');await writeFile(join(root,'manifest.json'),JSON.stringify({assets,favicon}));
 const app=buildApp({webRoot:root});t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 for(const [extension,name] of Object.entries(favicon)){const redirect=await app.inject({url:'/favicon.'+extension});assert.equal(redirect.statusCode,302);assert.equal(redirect.headers.location,'/assets/'+name);const icon=await app.inject({url:'/assets/'+name});assert.equal(icon.statusCode,200);assert.match(String(icon.headers['content-type']),extension==='svg'?/image\/svg\+xml/:/image\/x-icon/);assert.match(String(icon.headers['cache-control']),/immutable/);}
});
