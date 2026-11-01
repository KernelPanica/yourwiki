/** Independent HTTP process: server stalls cannot delay this process's clock. Fixture cookies only. */
import {setTimeout as delay} from 'node:timers/promises';
const [address,documentId,cookie]=process.argv.slice(2),samples=new Map<string,number[]>();let stopped=false,phase='preparation';
process.on('message',(value:any)=>{if(value?.phase)phase=value.phase;if(value?.stop)stopped=true;});
process.send?.({ready:true});
try{let n=0;while(!stopped){const route=n++%2?'history?limit=50':'view',key=phase+'/'+route,start=performance.now(),response=await fetch(address+'/api/documents/'+documentId+'/'+route,{headers:{cookie},signal:AbortSignal.timeout(30000)});if(response.status!==200)throw new Error('Observer HTTP '+response.status);await response.arrayBuffer();const times=samples.get(key)??[];times.push(performance.now()-start);samples.set(key,times);await delay(5);}
 const result=Object.fromEntries([...samples].map(([key,values])=>{values.sort((a,b)=>a-b);return [key,{samples:values.length,maxMs:Math.round(values.at(-1)!),p95Ms:Math.round(values[Math.floor((values.length-1)*.95)]),p99Ms:Math.round(values[Math.floor((values.length-1)*.99)])}];}));process.send?.({result});process.disconnect?.();
}catch(error){process.send?.({error:String(error)});process.disconnect?.();process.exitCode=1;}
