import {Worker} from 'node:worker_threads';
import {DocumentError} from '../document-errors.ts';
import type {PluginField,PluginAction} from './sdk.ts';
export type Manifest={id:string;name:string;version:string;description:string;fields:PluginField[];actions:PluginAction[]};
const key=/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
function text(value:unknown,max:number){if(typeof value!=='string'||!value.trim()||value.length>max)throw new DocumentError('PLUGIN_INVALID');return value;}
function fields(value:unknown,secrets=true):PluginField[]{if(value===undefined)return [];if(!Array.isArray(value)||value.length>24)throw new DocumentError('PLUGIN_INVALID');const seen=new Set<string>();return value.map(v=>{if(!v||!key.test(v.key)||seen.has(v.key)||!['text','secret','url','textarea'].includes(v.type)||!secrets&&v.type==='secret'||v.required!==undefined&&typeof v.required!=='boolean')throw new DocumentError('PLUGIN_INVALID');seen.add(v.key);return {key:v.key,label:text(v.label,120),type:v.type,required:v.required===true};});}
export function manifest(value:any):Manifest{if(!value||!key.test(value.id)||!Array.isArray(value.actions)||!value.actions.length||value.actions.length>24)throw new DocumentError('PLUGIN_INVALID');const seen=new Set<string>();return {id:value.id,name:text(value.name,120),version:text(value.version,40),description:value.description===undefined?'':text(value.description,1000),fields:fields(value.fields),actions:value.actions.map((a:any)=>{if(!a||!key.test(a.id)||seen.has(a.id))throw new DocumentError('PLUGIN_INVALID');seen.add(a.id);return {id:a.id,label:text(a.label,120),description:a.description===undefined?undefined:text(a.description,500),fields:fields(a.fields,false)};})};}
const workerCode=`
const {parentPort,workerData}=require('node:worker_threads');
(async()=>{try{
 const {stripTypeScriptTypes}=require('node:module');
 const js=stripTypeScriptTypes(workerData.source,{mode:'strip'});
 const module=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
 const p=module.default;if(!p||typeof p.execute!=='function')throw Error();
 if(workerData.inspect){parentPort.postMessage({ok:true,value:JSON.parse(JSON.stringify({id:p.id,name:p.name,version:p.version,description:p.description,fields:p.fields,actions:p.actions}))});}
 else{const value=await p.execute({...workerData.context,fetch:globalThis.fetch});const json=JSON.stringify(value??null);if(Buffer.byteLength(json)>131072)throw Error();parentPort.postMessage({ok:true,value:JSON.parse(json)});}
 }catch{parentPort.postMessage({ok:false});}
})();`;
/** Workers provide resource/lifecycle bounds, not a security sandbox. Install trusted modules only. */
export class PluginRunner{
 private running=new Set<Worker>();private closed=false;
 private timeout:number;
 constructor(timeout=15000){this.timeout=timeout;}
 async run(source:string,context?:unknown):Promise<any>{if(this.closed)throw new DocumentError('PLUGIN_UNAVAILABLE');if(this.running.size>=2)throw new DocumentError('PLUGIN_BUSY');if(typeof source!=='string'||!source.trim()||Buffer.byteLength(source)>262144)throw new DocumentError('PLUGIN_INVALID');
  const worker=new Worker(workerCode,{eval:true,workerData:{source,inspect:context===undefined,context},resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:16,stackSizeMb:4},stdout:true,stderr:true});this.running.add(worker);worker.stdout?.resume();worker.stderr?.resume();
  return new Promise((resolve,reject)=>{let settled=false;const done=(code:string|null,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();this.running.delete(worker);if(code)reject(new DocumentError(code));else resolve(value);};const timer=setTimeout(()=>done('PLUGIN_TIMEOUT'),this.timeout);worker.once('message',m=>done(m?.ok?null:context===undefined?'PLUGIN_INVALID':'PLUGIN_EXECUTION_FAILED',m?.value));worker.once('error',()=>done('PLUGIN_EXECUTION_FAILED'));worker.once('exit',()=>done('PLUGIN_EXECUTION_FAILED'));});
 }
 async close(){this.closed=true;await Promise.all([...this.running].map(w=>w.terminate()));this.running.clear();}
}
