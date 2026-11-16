import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPreferences} from '../../apps/web/src/preferences.ts';
test('theme changes snap colours without overriding motion preference or persisting a stale theme',()=>{
 const globals=['document','window','requestAnimationFrame','cancelAnimationFrame','localStorage','CustomEvent'],saved=new Map(globals.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const frames=new Map(),dataset={theme:'light'},stored=new Map();let next=0;
 Object.assign(globalThis,{document:{documentElement:{dataset}},window:{dispatchEvent(){}},CustomEvent:class{constructor(type,details){this.type=type;this.detail=details.detail;}},localStorage:{setItem:(key,value)=>stored.set(key,value)},requestAnimationFrame:callback=>{frames.set(++next,callback);return next;},cancelAnimationFrame:id=>frames.delete(id)});
 const runFrame=()=>{const batch=[...frames];frames.clear();for(const [,fn] of batch)fn();};
 const prefs={language:'auto',theme:'dark',animations:1,avatar:null,revision:1};
 try{
  applyPreferences(prefs);assert.equal(dataset.themeChanging,'true');assert.equal(dataset.animations,'on');assert.equal(dataset.theme,'dark');
  runFrame();assert.equal(dataset.themeChanging,'true');
  applyPreferences({...prefs,theme:'light',animations:0});runFrame();runFrame();
  assert.equal(dataset.themeChanging,undefined);assert.equal(dataset.animations,'off');assert.equal(dataset.theme,'light');assert.equal(JSON.parse(stored.get('yourwiki.preferences')).theme,'light');
 }finally{for(const key of globals){const descriptor=saved.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});
