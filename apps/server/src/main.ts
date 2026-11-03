import {configuredOffice} from './release/office-config.ts';
import {buildApp} from './app.ts';
import {openConfiguredApp} from './configured-app.ts';
// No implicit account, key or legacy discovery. Container binding is explicit.
const args=process.argv.slice(2);
let app:Awaited<ReturnType<typeof buildApp>>|undefined;
try{
 let port=3100,host='127.0.0.1';
 if(args.length){
  if(args.length<5)throw new Error();const paths=args.slice(0,5),seen=new Set<string>();
  for(let index=5;index<args.length;index+=2){const flag=args[index],value=args[index+1];if(!value||seen.has(flag))throw new Error();seen.add(flag);if(flag==='--port'&&/^[1-9][0-9]{0,4}$/.test(value)&&Number(value)<=65535)port=Number(value);else if(flag==='--host'&&['127.0.0.1','0.0.0.0','::1','::'].includes(value))host=value;else throw new Error();}
  app=await openConfiguredApp({databasePath:paths[0],storagePath:paths[1],secretKeyPath:paths[2],publicUrl:paths[3],webRoot:paths[4],office:configuredOffice(process.env),drawioRoot:process.env.YOURWIKI_DRAWIO_ROOT});
 }else app=buildApp();
 const server=app;
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void server.close().catch(()=>{process.exitCode=1;});});
 await server.listen({host,port});
 console.info(args.length?`Yourwiki configured backend listening on port ${port}`:'Yourwiki development backend: http://127.0.0.1:3100 (workspace not ready)');
}catch{
 try{await app?.close();}catch{/* No input, paths or credentials in startup errors. */}
 console.error('Yourwiki backend could not start. Configured mode requires an initialized v2 database, storage, existing private key, public origin and built web directory; optional --port and --host.');process.exitCode=1;
}
