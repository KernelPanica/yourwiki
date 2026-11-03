import {buildApp} from './app.ts';
import {openConfiguredApp} from './configured-app.ts';

// Opt-in development runtime. Production Django/Compose is not switched.
const args=process.argv.slice(2);
let app:Awaited<ReturnType<typeof buildApp>>|undefined;
try{
 let port=3100;
 if(args.length){
  if(![5,7].includes(args.length)||args.length===7&&(args[5]!=='--port'||! /^[1-9][0-9]{0,4}$/.test(args[6])||Number(args[6])>65535))throw new Error();
  if(args.length===7)port=Number(args[6]);
  app=await openConfiguredApp({databasePath:args[0],storagePath:args[1],secretKeyPath:args[2],publicUrl:args[3],webRoot:args[4]});
 }else app=buildApp();
 const server=app;
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void server.close().catch(()=>{process.exitCode=1;});});
 await server.listen({host:'127.0.0.1',port});
 console.info(args.length?`Yourwiki configured backend: http://127.0.0.1:${port}`:'Yourwiki development backend: http://127.0.0.1:3100 (workspace not ready)');
}catch{
 try{await app?.close();}catch{/* No input, paths or credentials in startup errors. */}
 console.error('Yourwiki backend could not start. Configured mode requires an initialized v2 database, storage, existing private key, public origin and built web directory; optional --port.');process.exitCode=1;
}
