let guard:(()=>boolean)|undefined;
export function registerNavigationGuard(value:()=>boolean){guard=value;return()=>{if(guard===value)guard=undefined;};}
export function allowNavigation(){return guard?.()??true;}
