import {access,copyFile,mkdir,readFile,rename,rm} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';

export async function recoverBuild(dist) {
 try{await access(dist);return;}catch(error){if(error.code!=='ENOENT')throw error;}
 try{await rename(dist+'.previous',dist);}catch(error){if(error.code!=='ENOENT')throw error;}
}

// Keep one preceding release for tabs which still load its lazy chunks. Never
// carry a merged manifest forward: that made every rebuild grow indefinitely.
export async function retainPreviousAssets(dist,staging,current) {
 let previous;
 try{previous=JSON.parse(await readFile(resolve(dist,'manifest.json'),'utf8'));}
 catch(error){if(error.code==='ENOENT')return {...current};throw error;}
 const assets={...current};
 for(const [name,meta] of Object.entries(previous.currentAssets??previous.assets??{})) {
  if(Object.hasOwn(assets,name))continue;
  const source=resolve(dist,'assets',name),target=resolve(staging,'assets',name);
  if(!source.startsWith(resolve(dist,'assets')+sep)||!target.startsWith(resolve(staging,'assets')+sep))throw new Error('Invalid build asset path');
  await mkdir(dirname(target),{recursive:true});
  for(const suffix of ['', '.gz','.br'])await copyFile(source+suffix,target+suffix);
  assets[name]=meta;
 }
 return assets;
}

export async function publishBuild(staging,dist) {
 const retired=dist+'.previous';
 await rm(retired,{recursive:true,force:true});
 let moved=false;
 try{await rename(dist,retired);moved=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 try{await rename(staging,dist);}catch(error){if(moved)await rename(retired,dist);throw error;}
 await rm(retired,{recursive:true,force:true});
}
