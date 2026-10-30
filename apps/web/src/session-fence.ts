let generation=0,blocked=false,controller=new AbortController();
const listeners=new Set<()=>void>();
export function sessionSnapshot(){return {generation,blocked,signal:controller.signal};}
export function sessionIsCurrent(value:number){return !blocked&&value===generation;}
export function sessionGenerationIsCurrent(value:number){return value===generation;}
export function blockSession(){
 generation++;blocked=true;controller.abort();
 for(const listener of [...listeners]){try{listener();}catch{/* Other editors must still be fenced. */}}
}
/** Call only after an explicit authenticated account response, before mounting private UI. */
export function resumeSession(){generation++;controller.abort();controller=new AbortController();blocked=false;}
export function onSessionBlocked(listener:()=>void){listeners.add(listener);if(blocked)listener();return()=>{listeners.delete(listener);};}
