import { build } from 'esbuild';
import { readFile,writeFile,mkdir,rename,copyFile } from 'node:fs/promises';
import { basename,resolve } from 'node:path';
import { gzipSync,brotliCompressSync,constants } from 'node:zlib';
const root=resolve(import.meta.dirname),dist=resolve(root,'dist');
await mkdir(resolve(dist,'assets'),{recursive:true});
const result=await build({absWorkingDir:root,entryPoints:['src/main.tsx'],outdir:'dist/assets',bundle:true,minify:true,splitting:true,format:'esm',target:'es2022',jsx:'automatic',metafile:true,entryNames:'[name]-[hash]',chunkNames:'chunk-[hash]',assetNames:'[name]-[hash]',publicPath:'/assets',loader:{'.woff2':'file'},define:{'process.env.NODE_ENV':'"production"'}});
let previous={assets:{}};
try{previous=JSON.parse(await readFile(resolve(dist,'manifest.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
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
if(!script||!css||!font)throw new Error('Incomplete web build');
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f6f7f9"><title>Yourwiki</title><link rel="preload" href="/assets/${font}" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/assets/${css}"><script type="module" src="/assets/${script}"></script></head><body><div id="root"></div><noscript>Enable JavaScript to open Yourwiki.</noscript></body></html>`;
await writeFile(resolve(dist,'manifest.json.next'),JSON.stringify({assets,script,css,font},null,2));
await rename(resolve(dist,'manifest.json.next'),resolve(dist,'manifest.json'));
await writeFile(resolve(dist,'index.html.next'),html);await rename(resolve(dist,'index.html.next'),resolve(dist,'index.html'));
await mkdir(resolve(dist,'licenses'),{recursive:true});
for(const [source,target] of [['../../wiki/static/wiki/fonts/Inter-OFL.txt','Inter-OFL.txt'],['node_modules/react/LICENSE','React-LICENSE.txt'],['node_modules/react-dom/LICENSE','ReactDOM-LICENSE.txt']])await copyFile(resolve(root,source),resolve(dist,'licenses',target));
console.log(JSON.stringify({script,css,font,assets:Object.fromEntries(Object.entries(assets).filter(([name])=>Object.keys(result.metafile.outputs).some(path=>basename(path)===name)))},null,2));
