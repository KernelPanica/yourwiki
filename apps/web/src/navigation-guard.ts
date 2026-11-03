type Guard={confirm:()=>boolean|Promise<boolean>;dirty:()=>boolean};
// An editor and a review draft can coexist. Each owns only its registration.
const guards=new Set<Guard>();
let revision=0;
export function registerNavigationGuard(confirm:()=>boolean|Promise<boolean>,dirty:()=>boolean=()=>false){const value={confirm,dirty};guards.add(value);revision++;return()=>{if(guards.delete(value))revision++;};}
export function allowNavigation():boolean|Promise<boolean>{const snapshot=[...guards];function next(index:number):boolean|Promise<boolean>{if(index===snapshot.length)return true;const result=snapshot[index].confirm();return typeof result==='boolean'?(result?next(index+1):false):result.then(allowed=>allowed?next(index+1):false);}return next(0);}
export function hasUnsavedChanges(){try{return [...guards].some(guard=>guard.dirty());}catch{return true;}}
let departing=false;
/** Keep every current editor/draft mounted until all guards acknowledge departure. */
export async function requestNavigation(action:()=>void|Promise<void>){if(departing)return false;departing=true;const currentRevision=revision;try{if(!await allowNavigation()||revision!==currentRevision)return false;await action();return true;}catch{return false;}finally{departing=false;}}
