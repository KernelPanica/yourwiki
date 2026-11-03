import {setTimeout as delay} from 'node:timers/promises';
type SourceWorker={runOnce(signal?:AbortSignal):Promise<string>};
/** One source job at a time. Rotate queue priority so discovery and either direction receive turns. */
export class ProviderLoop {
 private scheduler:{tick():unknown};private workers:SourceWorker[];private next=0;private busy=false;
 constructor(scheduler:{tick():unknown},outgoing:SourceWorker,incoming:SourceWorker,discovery?:SourceWorker,imports?:SourceWorker,trash?:SourceWorker,...additional:SourceWorker[]){this.scheduler=scheduler;this.workers=[outgoing,incoming,...(discovery?[discovery]:[]),...(imports?[imports]:[]),...(trash?[trash]:[]),...additional];}
 async tick(signal?:AbortSignal):Promise<'idle'|'worked'>{
  if(this.busy)throw new Error('Provider loop is already running');if(signal?.aborted)return 'idle';this.busy=true;
  try{
   this.scheduler.tick();const first=this.next;this.next=(this.next+1)%this.workers.length;
   for(let offset=0;offset<this.workers.length;offset++){if(signal?.aborted)return 'idle';if(await this.workers[(first+offset)%this.workers.length].runOnce(signal)!=='idle')return 'worked';}return 'idle';
  }finally{this.busy=false;}
 }
 async run(signal:AbortSignal):Promise<void>{while(!signal.aborted){if(await this.tick(signal)==='idle')try{await delay(250,undefined,{signal});}catch{if(!signal.aborted)throw new Error('Provider polling failed');}}}
}
