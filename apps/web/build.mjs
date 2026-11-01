import { build } from 'esbuild';
import { readFile,writeFile,mkdir,rename,copyFile,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename,resolve,dirname,extname } from 'node:path';
import { gzipSync,brotliCompressSync,constants } from 'node:zlib';
const root=resolve(import.meta.dirname),dist=resolve(root,'dist');
await mkdir(resolve(dist,'assets'),{recursive:true});
const pdfRoot=resolve(root,'node_modules/pdfjs-dist'),pdfFiles=[];
for(const dir of ['cmaps','standard_fonts','wasm','web/images'])for(const entry of await readdir(resolve(pdfRoot,dir),{withFileTypes:true}))if(entry.isFile())pdfFiles.push({name:dir.replace('web/','')+'/'+entry.name,content:await readFile(resolve(pdfRoot,dir,entry.name))});
pdfFiles.push({name:'pdf.worker.mjs',content:await readFile(resolve(pdfRoot,'build/pdf.worker.mjs'))});
pdfFiles.sort((a,b)=>a.name.localeCompare(b.name));
const hash=createHash('sha256');for(const item of pdfFiles)hash.update(item.name).update(item.content);
const pdfDirectory='pdf-'+hash.digest('hex').slice(0,16);
const pdfCss=await build({absWorkingDir:root,entryPoints:['src/pdf-workspace.css'],outdir:'dist/assets',bundle:true,minify:true,metafile:true,entryNames:'[name]-[hash]',loader:{'.svg':'dataurl','.gif':'dataurl','.png':'dataurl'}});
const pdfStyle=Object.keys(pdfCss.metafile.outputs).find(name=>name.endsWith('.css'));
if(!pdfStyle)throw new Error('Missing PDF styles');
const archiveWorker=await build({absWorkingDir:root,entryPoints:['src/archive-hash-worker.ts'],outdir:'dist/assets',bundle:true,minify:true,format:'esm',target:'es2022',metafile:true,entryNames:'archive-hash-[hash]'});
const archiveWorkerPath=Object.keys(archiveWorker.metafile.outputs).find(name=>name.endsWith('.js'));
if(!archiveWorkerPath)throw new Error('Missing archive hash worker');
const result=await build({absWorkingDir:root,entryPoints:['src/main.tsx'],outdir:'dist/assets',bundle:true,minify:true,splitting:true,format:'esm',target:'es2022',jsx:'automatic',metafile:true,entryNames:'[name]-[hash]',chunkNames:'chunk-[hash]',assetNames:'[name]-[hash]',publicPath:'/assets',loader:{'.woff2':'file','.svg':'dataurl','.gif':'dataurl','.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"',__PDF_ASSET_BASE__:JSON.stringify('/assets/'+pdfDirectory+'/'),__PDF_STYLESHEET__:JSON.stringify('/assets/'+basename(pdfStyle)),__ARCHIVE_HASH_WORKER__:JSON.stringify('/assets/'+basename(archiveWorkerPath))}});
let previous={assets:{}};
try{previous=JSON.parse(await readFile(resolve(dist,'manifest.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
Object.assign(result.metafile.outputs,pdfCss.metafile.outputs,archiveWorker.metafile.outputs);
const assets={...previous.assets};
let script='',css='',font='';
for(const [name,meta] of Object.entries(result.metafile.outputs)) {
  const file=basename(name),content=await readFile(resolve(root,name));
  const type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'font/woff2';
  const gzip=gzipSync(content),br=brotliCompressSync(content,{params:{[constants.BROTLI_PARAM_QUALITY]:9}});
  await writeFile(resolve(dist,'assets',file+'.gz'),gzip);await writeFile(resolve(dist,'assets',file+'.br'),br);
  assets[file]={type,size:content.length,gzipSize:gzip.length,brSize:br.length};
  if(meta.entryPoint==='src/main.tsx')script=file;
  if(file.startsWith('main-')&&file.endsWith('.css'))css=file;
  if(file.endsWith('.woff2'))font=file;
}
for(const item of pdfFiles){
 const name=pdfDirectory+'/'+item.name,path=resolve(dist,'assets',name),type={'.mjs':'text/javascript','.wasm':'application/wasm','.ttf':'font/ttf','.otf':'font/otf','.svg':'image/svg+xml','.png':'image/png','.gif':'image/gif'}[extname(item.name)]??'application/octet-stream';
 const gzip=gzipSync(item.content),br=brotliCompressSync(item.content);
 await mkdir(dirname(path),{recursive:true});await writeFile(path,item.content);await writeFile(path+'.gz',gzip);await writeFile(path+'.br',br);
 assets[name]={type,size:item.content.length,gzipSize:gzip.length,brSize:br.length};
}
if(!script||!css||!font)throw new Error('Incomplete web build');
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f6f7f9"><title>Yourwiki</title><link rel="preload" href="/assets/${font}" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/assets/${css}"><script type="module" src="/assets/${script}"></script></head><body><div id="root"></div><noscript>Enable JavaScript to open Yourwiki.</noscript></body></html>`;
await writeFile(resolve(dist,'manifest.json.next'),JSON.stringify({assets,script,css,font},null,2));
await rename(resolve(dist,'manifest.json.next'),resolve(dist,'manifest.json'));
await writeFile(resolve(dist,'index.html.next'),html);await rename(resolve(dist,'index.html.next'),resolve(dist,'index.html'));
await mkdir(resolve(dist,'licenses'),{recursive:true});
for(const [source,target] of [['../../wiki/static/wiki/fonts/Inter-OFL.txt','Inter-OFL.txt'],['node_modules/react/LICENSE','React-LICENSE.txt'],['node_modules/react-dom/LICENSE','ReactDOM-LICENSE.txt'],['node_modules/pdfjs-dist/LICENSE','PDFjs-LICENSE.txt']])await copyFile(resolve(root,source),resolve(dist,'licenses',target));
console.log(JSON.stringify({script,css,font,assets:Object.fromEntries(Object.entries(assets).filter(([name])=>Object.keys(result.metafile.outputs).some(path=>basename(path)===name)))},null,2));
