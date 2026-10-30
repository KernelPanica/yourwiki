type Guard={confirm:()=>boolean|Promise<boolean>;dirty:()=>boolean};
let guard:Guard|undefined;
export function registerNavigationGuard(confirm:()=>boolean|Promise<boolean>,dirty:()=>boolean=()=>false){const value={confirm,dirty};guard=value;return()=>{if(guard===value)guard=undefined;};}
export function allowNavigation(){return guard?.confirm()??true;}
export function hasUnsavedChanges(){try{return guard?.dirty()??false;}catch{return true;}}

let departing=false;
/** Keep the current editor mounted until its guard has acknowledged release. */
export async function requestNavigation(action:()=>void|Promise<void>){
 if(departing)return false;departing=true;const current=guard;
 try{if(!await(current?.confirm()??true)||guard!==current)return false;await action();return true;}catch{return false;}finally{departing=false;}
}
