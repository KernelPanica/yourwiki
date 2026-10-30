import {spawn} from 'node:child_process';
import {realpath,stat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {transaction,type Database} from '../database.ts';
import {BlobTooLargeError,type BlobStore,type BlobRef} from '../storage/blobs.ts';
import {OfficeError} from './errors.ts';
import {officeFormats} from './formats.ts';
type Options={bwrap?:string;prlimit?:string;timeoutMs?:number;queueTimeoutMs?:number;heapMb?:number};
/** One leased validation/preparation process per workspace database, including across HTTP instances. */
export class OfficeValidationWorker {
 private db:Database;private options:Required<Options>;private pending=0;
 constructor(db:Database,options:Options={}){
  this.db=db;this.options={bwrap:'/usr/bin/bwrap',prlimit:'/usr/bin/prlimit',timeoutMs:60000,queueTimeoutMs:10000,heapMb:96,...options};
  if(!isAbsolute(this.options.bwrap)||!isAbsolute(this.options.prlimit)||![this.options.timeoutMs,this.options.queueTimeoutMs,this.options.heapMb].every(n=>Number.isSafeInteger(n)&&n>0)||this.options.timeoutMs>3600000||this.options.queueTimeoutMs>60000||this.options.heapMb<32||this.options.heapMb>384)throw new Error('Invalid office validation worker limits');
 }
 async validate(store:BlobStore,value:BlobRef,format:string,signal:AbortSignal,limits:{maxExpandedBytes?:number}={}){
  const blob={...value};await this.execute(store,blob,format,signal,limits);return {...blob,format,validatorVersion:'office-basic-1'};
 }
 async prepare(store:BlobStore,value:BlobRef,format:string,target:BlobStore,signal:AbortSignal,limits:{maxExpandedBytes?:number;maxOutputBytes?:number}={}){
  const result=await this.execute(store,value,format,signal,limits,target);if(!result)throw new OfficeError('OFFICE_VALIDATOR_FAILED');return result;
 }
 private async execute(store:BlobStore,value:BlobRef,format:string,signal:AbortSignal,limits:{maxExpandedBytes?:number;maxOutputBytes?:number},target?:BlobStore):Promise<BlobRef|undefined>{
  const blob={...value},maximum=limits.maxExpandedBytes??40*1024**3,outputLimit=limits.maxOutputBytes??4*1024**3;
  signal.throwIfAborted();if(!Number.isSafeInteger(outputLimit)||outputLimit<1)throw new OfficeError('OFFICE_FILE_BUDGET');if(!officeFormats.has(format)||!Number.isSafeInteger(blob.size)||blob.size<0||!Number.isSafeInteger(maximum)||maximum<1)throw new OfficeError('INVALID_OFFICE_FILE');
  if(this.pending>=15)throw new OfficeError('OFFICE_VALIDATOR_BUSY');this.pending++;
  try{
   if(process.platform!=='linux')throw new OfficeError('OFFICE_VALIDATOR_UNAVAILABLE');
   const code=fileURLToPath(new URL('.',import.meta.url)),modules=fileURLToPath(new URL('../../node_modules/',import.meta.url)),node=await realpath(process.execPath),input=await store.localFile(blob.digest);
   try{for(const path of [this.options.bwrap,this.options.prlimit,'/usr/bin/nice'])if(!(await stat(path)).isFile())throw new Error();}
   catch{throw new OfficeError('OFFICE_VALIDATOR_UNAVAILABLE');}
   const token=randomUUID(),started=Date.now();let claimed=false;
   while(!claimed){
    signal.throwIfAborted();claimed=transaction(this.db,()=>{
     const now=Date.now();if(this.db.prepare("SELECT 1 FROM worker_slots WHERE name='office-validation' AND lease_until>?").get(now))return false;
     this.db.prepare("INSERT INTO worker_slots(name,token,lease_until) VALUES('office-validation',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until").run(token,now+30000);return true;
    });
    if(!claimed){if(Date.now()-started>=this.options.queueTimeoutMs)throw new OfficeError('OFFICE_VALIDATOR_BUSY');await delay(Math.min(10,this.options.queueTimeoutMs),undefined,{signal});}
   }
   try{
    signal.throwIfAborted();
    const entry=target?'transit-process.ts':'validation-process.ts';
    const args=['-n','10',this.options.prlimit,'--as=8589934592','--fsize=1048576',`--cpu=${Math.ceil(this.options.timeoutMs/1000)}`,'--',this.options.bwrap,
     '--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
     '--ro-bind',input,'/input','--dir','/validator','--ro-bind',join(code,'validation-process.ts'),'/validator/validation-process.ts','--ro-bind',join(code,'validation.ts'),'/validator/validation.ts','--ro-bind',join(code,'errors.ts'),'/validator/errors.ts',
     '--ro-bind',fileURLToPath(new URL('../../package.json',import.meta.url)),'/validator/package.json','--ro-bind',modules,'/validator/node_modules','--proc','/proc','--dev','/dev','--size','16777216','--tmpfs','/tmp','--chdir','/validator','--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp','--setenv','LANG','C.UTF-8'];
    for(const file of ['transit-process.ts','transit.ts','legacy-markdown.ts'])args.push('--ro-bind',join(code,file),'/validator/'+file);
    const executable=node.startsWith('/usr/')?node:'/runtime-node';if(executable==='/runtime-node')args.push('--ro-bind',node,executable);
    args.push(executable,`--max-old-space-size=${this.options.heapMb}`,'--max-semi-space-size=8','--stack-size=512','/validator/'+entry,format,String(blob.size),String(maximum),String(this.options.timeoutMs),String(outputLimit));
    const child=spawn('/usr/bin/nice',args,{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe'],detached:true});let output='',errors='',timedOut=false,lost=false,excess=false;
    const kill=()=>{if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}};
    if(!target)child.stdout.on('data',chunk=>{if(output.length+chunk.length>512){excess=true;kill();}else output+=chunk.toString();});child.stderr.on('data',chunk=>{if(errors.length<4096)errors+=chunk.toString().slice(0,4096-errors.length);});
    const writing=target?target.put(child.stdout,{maxBytes:outputLimit,signal}).then(value=>({value,error:null}),error=>{kill();return {value:undefined,error};}):Promise.resolve({value:undefined,error:null});
    const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
    const owns=()=>!!this.db.prepare("SELECT 1 FROM worker_slots WHERE name='office-validation' AND token=? AND lease_until>?").get(token,Date.now());
    const heartbeat=setInterval(()=>{try{if(this.db.prepare("UPDATE worker_slots SET lease_until=? WHERE name='office-validation' AND token=? AND lease_until>?").run(Date.now()+30000,token,Date.now()).changes!==1){lost=true;kill();}}catch{lost=true;kill();}},10000);
    const deadline=setTimeout(()=>{timedOut=true;kill();},this.options.timeoutMs);signal.addEventListener('abort',kill,{once:true});if(signal.aborted)kill();
    try{
     let ended;try{ended=await exit;}catch{await writing;throw new OfficeError('OFFICE_VALIDATOR_UNAVAILABLE');}const prepared=await writing;
     signal.throwIfAborted();if(timedOut)throw new OfficeError('OFFICE_VALIDATION_TIMEOUT');if(lost||!owns())throw new OfficeError('OFFICE_VALIDATOR_LEASE_LOST');
     if(prepared.error instanceof BlobTooLargeError)throw new OfficeError('OFFICE_FILE_BUDGET');
     if(ended.code===0&&!prepared.error&&(target?!!prepared.value:output==='OK\n'&&!excess))return prepared.value;
     const known=['INVALID_OFFICE_FILE','OFFICE_FILE_BUDGET','OFFICE_VALIDATION_TIMEOUT'];if(known.includes(errors))throw new OfficeError(errors);
     if(ended.signal==='SIGXCPU'||/heap out of memory|Allocation failed/i.test(errors))throw new OfficeError('OFFICE_FILE_BUDGET');
     throw new OfficeError('OFFICE_VALIDATOR_FAILED');
    }finally{clearInterval(heartbeat);clearTimeout(deadline);signal.removeEventListener('abort',kill);if(child.exitCode===null&&child.signalCode===null)kill();}
   }finally{this.db.prepare("DELETE FROM worker_slots WHERE name='office-validation' AND token=?").run(token);}
  }finally{this.pending--;}
 }
}
