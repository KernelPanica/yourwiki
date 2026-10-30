type Guard={confirm:()=>boolean;dirty:()=>boolean};
let guard:Guard|undefined;
export function registerNavigationGuard(confirm:()=>boolean,dirty:()=>boolean=()=>false){const value={confirm,dirty};guard=value;return()=>{if(guard===value)guard=undefined;};}
export function allowNavigation(){return guard?.confirm()??true;}
export function hasUnsavedChanges(){try{return guard?.dirty()??false;}catch{return true;}}
