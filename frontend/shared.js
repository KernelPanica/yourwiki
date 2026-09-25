import * as Y from 'yjs';
export { Y };
export const boot = JSON.parse(document.getElementById('editor-bootstrap').textContent);
export const ydoc = new Y.Doc();
export const unb64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export const b64 = value => {let s=''; for(let i=0;i<value.length;i+=8192) s+=String.fromCharCode(...value.subarray(i,i+8192)); return btoa(s);};
Y.applyUpdate(ydoc, unb64(boot.state), 'remote');
export const objects = ydoc.getMap('objects');
export const toolbar = document.getElementById('editor-toolbar');
export const host = document.getElementById('visual-editor');
let holding=false,reviewUpdates=[];
export function holdUpdates(value){holding=value;if(!value)reviewUpdates=[];}
export function heldUpdate(){return Y.mergeUpdates(reviewUpdates);}
export function queueReviewUpdate(update){if(!holding)return false;reviewUpdates.push(update);return true;}
export function error(message) {const box=document.getElementById('editor-error'); box.textContent=message;box.hidden=false;}
export async function api(path, options={}) {
  const csrf = document.cookie.split('; ').find(v=>v.startsWith('csrftoken='))?.split('=')[1] || '';
  const response=await fetch(path,{...options,headers:{'X-CSRFToken':decodeURIComponent(csrf),...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),...options.headers}});
  if(!response.ok) {let value;try{value=await response.json();}catch{} throw new Error(value?.error || `Request failed (${response.status}).`);}
  return response.json();
}
export function button(label, action, {write=true, parent=toolbar}={}) {
  const el=document.createElement('button'); el.type='button';el.className='button';el.textContent=label;el.title=label;el.setAttribute('aria-label',label);
  if(write) {el.dataset.write='';el.disabled=!boot.write;}
  el.addEventListener('mousedown',e=>e.preventDefault());
  el.addEventListener('click',()=>Promise.resolve().then(action).catch(e=>error(e.message)));
  parent.append(el);return el;
}
export function select(label, values, action) {
  const wrap=document.createElement('label');wrap.className='toolbar-label';wrap.textContent=label;
  const el=document.createElement('select');el.setAttribute('aria-label',label);el.dataset.write='';el.disabled=!boot.write;
  for(const [value,text] of values){const option=new Option(text,value);el.add(option);}
  el.onchange=()=>action(el.value);wrap.append(el);toolbar.append(wrap);return el;
}
export function dialog(title, fields) {
  const el=document.getElementById('editor-dialog'), container=document.getElementById('dialog-fields');
  document.getElementById('dialog-title').textContent=title;container.replaceChildren();
  for(const [name,label,value='',type='text'] of fields){const row=document.createElement('label');row.textContent=label;const input=document.createElement(type==='textarea'?'textarea':'input');input.name=name;input.value=value;if(type!=='textarea')input.type=type;row.append(input);container.append(row);}
  el.returnValue='cancel';el.showModal();
  return new Promise(resolve=>el.addEventListener('close',()=>resolve(el.returnValue==='ok'?Object.fromEntries(new FormData(el.querySelector('form'))):null),{once:true}));
}
export function flatten(value,path=[],result={}) {
  if(value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length){for(const [k,v] of Object.entries(value))flatten(v,[...path,k],result);}
  else result[JSON.stringify(path)]=value;
  return result;
}
export function readObjects() {
  const root={};for(const [key,value] of objects){const path=JSON.parse(key);if(!path.length||path.some(k=>['__proto__','prototype','constructor'].includes(k)))continue;let cur=root;for(const k of path.slice(0,-1)){if(!cur[k]||typeof cur[k]!=='object')cur[k]={};cur=cur[k];}cur[path.at(-1)]=structuredClone(value);}return root;
}
export function writeObjects(value, previous=readObjects()) {
  if(!boot.write)return;
  const next=flatten(value),prev=flatten(previous);
  ydoc.transact(()=>{for(const key of Object.keys(prev))if(!(key in next))objects.delete(key);for(const [key,v] of Object.entries(next))if(JSON.stringify(prev[key])!==JSON.stringify(v))objects.set(key,v);},'local');
}
export function graphUndo(){const undo=new Y.UndoManager(objects,{trackedOrigins:new Set(['local'])});button('Undo',()=>undo.undo());button('Redo',()=>undo.redo());return undo;}
