/** Local hints only: the list always reloads through authenticated, current ACL. */
const listeners=new Set<()=>void>();
export function subscribeRecentActivity(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
export function publishRecentActivity(){for(const listener of [...listeners]){try{listener();}catch{/* A broken view cannot stop other lists refreshing. */}}}
