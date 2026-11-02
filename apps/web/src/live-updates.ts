import {onSessionBlocked,sessionIsCurrent,sessionSnapshot} from './session-fence.ts';
export type Invalidation={type:'all'}|{type:'documents';documentIds:string[]};
const listeners=new Set<(event:Invalidation)=>void>();
export function subscribeChanges(listener:(event:Invalidation)=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
export function publishChanges(event:Invalidation){for(const listener of [...listeners])listener(event);}
type Source={addEventListener:(type:string,listener:(event:{data:string})=>void)=>void;close:()=>void};
/** One stream per authenticated React root. Hints never confer read/write authority. */
export function startChangeFeed(options:{create?:()=>Source;verify:()=>Promise<boolean>;changed:(event:Invalidation)=>void;expired:()=>void}){
 if(sessionSnapshot().blocked)return()=>{};
 const generation=sessionSnapshot().generation;let stopped=false,source:Source|undefined,timer:ReturnType<typeof setTimeout>|undefined,serial=0,verified=false,queued=false,all=false,delay=1500;
 const ids=new Set<string>();
 const current=()=>!stopped&&sessionIsCurrent(generation);
 const enqueue=(event:Invalidation)=>{
  if(!current()||!verified)return;
  if(event.type==='all')all=true;else for(const id of event.documentIds){ids.add(id);if(ids.size>16){all=true;ids.clear();break;}}
  if(queued)return;queued=true;queueMicrotask(()=>{queued=false;if(!current()||!verified){all=false;ids.clear();return;}const event:Invalidation=all?{type:'all'}:{type:'documents',documentIds:[...ids]};all=false;ids.clear();options.changed(event);});
 };
 function stop(){if(stopped)return;stopped=true;serial++;verified=false;clearTimeout(timer);source?.close();removeBlock();}
 const removeBlock=onSessionBlocked(()=>stop());
 function expire(){if(!current())return;stop();options.expired();}
 function retry(){if(!current())return;verified=false;source?.close();serial++;clearTimeout(timer);timer=setTimeout(connect,delay);delay=Math.min(30_000,delay*2);}
 function connect(){
  if(!current())return;const attempt=++serial;verified=false;
  const valid=()=>current()&&attempt===serial;
  try{source=(options.create??(()=>new EventSource('/api/changes')))();}catch{retry();return;}
  source.addEventListener('ready',()=>{void (async()=>{try{const accepted=await options.verify();if(!valid())return;if(!accepted){expire();return;}verified=true;delay=1500;enqueue({type:'all'});}catch{if(valid())retry();}})();});
  source.addEventListener('access',()=>{if(valid())enqueue({type:'all'});});
  source.addEventListener('documents',event=>{
   if(!valid()||!verified)return;
   try{const data=JSON.parse(event.data) as {documentIds?:unknown};if(!Array.isArray(data.documentIds)||data.documentIds.length>16||!data.documentIds.every(id=>typeof id==='string'&&id.length>0&&id.length<=256))throw new Error('INVALID_HINT');enqueue(data.documentIds.length?{type:'documents',documentIds:data.documentIds}:{type:'all'});}catch{enqueue({type:'all'});}
  });
  source.addEventListener('session-expired',()=>{if(valid())expire();});
  source.addEventListener('error',()=>{
   if(!valid())return;source?.close();verified=false;const recovery=++serial;
   const recovering=()=>current()&&serial===recovery;
   void (async()=>{try{const accepted=await options.verify();if(!recovering())return;if(!accepted){expire();return;}retry();}catch{if(recovering())retry();}})();
  });
 }
 if(current())connect();return stop;
}
