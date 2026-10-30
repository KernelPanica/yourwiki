import {sessionIsCurrent,sessionSnapshot} from './session-fence.ts';
/** Owns only network IO: cancelling it leaves the PDF worker and local annotations intact. */
export class PdfRangeSource {
 private controller=new AbortController();
 private url:string;private length:number;private session:ReturnType<typeof sessionSnapshot>;private deliver:(begin:number,data:Uint8Array)=>void;private failed:(error:unknown)=>void;
 constructor(url:string,length:number,session:ReturnType<typeof sessionSnapshot>,deliver:(begin:number,data:Uint8Array)=>void,failed:(error:unknown)=>void){
  this.url=url;this.length=length;this.session=session;this.deliver=deliver;this.failed=failed;
  session.signal.addEventListener('abort',this.abort,{once:true});
  if(session.signal.aborted)this.abort();
 }
 abort=()=>{this.controller.abort();this.session.signal.removeEventListener('abort',this.abort);};
 async request(begin:number,end:number){
  if(this.controller.signal.aborted||!sessionIsCurrent(this.session.generation))return;
  try{
   const response=await fetch(this.url,{credentials:'same-origin',cache:'no-store',signal:this.controller.signal,headers:{Range:`bytes=${begin}-${end-1}`}});
   if(response.status!==206||response.headers.get('content-range')!==`bytes ${begin}-${end-1}/${this.length}`)throw new Error('INVALID_PDF_RANGE');
   const data=new Uint8Array(await response.arrayBuffer());
   if(this.controller.signal.aborted||!sessionIsCurrent(this.session.generation))return;
   if(data.length!==end-begin)throw new Error('INVALID_PDF_RANGE_LENGTH');
   this.deliver(begin,data);
  }catch(error){if(!this.controller.signal.aborted&&sessionIsCurrent(this.session.generation))this.failed(error);}
 }
}
