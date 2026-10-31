import {api,ApiError} from './api.ts';
import {onSessionBlocked,sessionIsCurrent,sessionSnapshot} from './session-fence.ts';
type State={phase:'idle'|'pending'|'saved'|'error';error:unknown};
type Options={documentId:string;csrf:string;request?:(url:string,init:RequestInit)=>Promise<unknown>;changed?:(state:State)=>void;recorded?:()=>void};
/** One real page opening; background view refresh must not reorder Recent. */
export class DocumentVisit{
 private options:Options;private fence=sessionSnapshot();private generation=this.fence.generation;private stopped=false;private lifetime=new AbortController();private remove=()=>{};private task:Promise<void>|null=null;private state:State={phase:'idle',error:null};
 constructor(options:Options){this.options=options;this.remove=onSessionBlocked(()=>{this.lifetime.abort();this.state={phase:'idle',error:null};this.options.changed?.(this.snapshot());});}
 snapshot(){return {...this.state};}
 private current(){return !this.stopped&&!this.lifetime.signal.aborted&&sessionIsCurrent(this.generation);}
 private update(state:State){if(this.current()){this.state=state;this.options.changed?.(this.snapshot());}}
 opened(){return this.state.phase==='idle'?this.record():this.task??Promise.resolve();}
 retry(){return this.state.phase==='error'?this.record():this.task??Promise.resolve();}
 private record(){
  if(!this.current())return Promise.resolve();this.update({phase:'pending',error:null});
  const request=this.options.request??api;
  this.task=(async()=>{try{
   const result=await request(`/api/documents/${encodeURIComponent(this.options.documentId)}/visit`,{method:'POST',signal:AbortSignal.any([this.lifetime.signal,this.fence.signal,AbortSignal.timeout(10000)]),headers:{'x-csrf-token':this.options.csrf}});
   if(result!==undefined)throw new ApiError('INVALID_VISIT_ACK');this.update({phase:'saved',error:null});
   if(!this.lifetime.signal.aborted&&sessionIsCurrent(this.generation))this.options.recorded?.();
  }catch(error){this.update({phase:'error',error});}})();return this.task;
 }
 // A tiny in-flight visit may finish after SPA departure; auth changes still abort it.
 dispose(){this.stopped=true;this.remove();}
}
