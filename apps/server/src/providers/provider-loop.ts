import {setTimeout as delay} from 'node:timers/promises';
type SourceWorker={runOnce(signal?:AbortSignal):Promise<string>};
/** One source job at a time. Alternate directions so a busy queue cannot starve the other. */
export class ProviderLoop {
 private scheduler:{tick():unknown};private outgoing:SourceWorker;private incoming:SourceWorker;private preferIncoming=false;private busy=false;
 constructor(scheduler:{tick():unknown},outgoing:SourceWorker,incoming:SourceWorker){this.scheduler=scheduler;this.outgoing=outgoing;this.incoming=incoming;}
 async tick(signal?:AbortSignal):Promise<'idle'|'worked'>{
  if(this.busy)throw new Error('Provider loop is already running');if(signal?.aborted)return 'idle';this.busy=true;
  try{
   this.scheduler.tick();const first=this.preferIncoming?this.incoming:this.outgoing,second=this.preferIncoming?this.outgoing:this.incoming;this.preferIncoming=!this.preferIncoming;
   if(await first.runOnce(signal)!=='idle')return 'worked';if(signal?.aborted)return 'idle';return await second.runOnce(signal)==='idle'?'idle':'worked';
  }finally{this.busy=false;}
 }
 async run(signal:AbortSignal):Promise<void>{while(!signal.aborted){if(await this.tick(signal)==='idle')try{await delay(250,undefined,{signal});}catch{if(!signal.aborted)throw new Error('Provider polling failed');}}}
}
