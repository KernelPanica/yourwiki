import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {bootstrap,workspacePaths} from '../apps/server/src/release/workspace.ts';

// A separate, persistent local installation. Never discover or modify legacy data.
const repo=resolve(import.meta.dirname,'..');
const data=join(repo,'instance','prototype-v2');
const paths=workspacePaths(join(data,'workspace'));
const port=Number(process.env.YOURWIKI_PROTOTYPE_PORT??3180);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid prototype port');
const origin=`http://127.0.0.1:${port}`;
const children:ChildProcess[]=[];
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;process.exitCode=code;for(const child of children){try{if(child.pid)process.kill(-child.pid,'SIGTERM');}catch{}}const timer=setTimeout(()=>{for(const child of children){try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}}},3000);timer.unref();}
process.once('SIGINT',()=>stop());process.once('SIGTERM',()=>stop());
function start(args:string[]){const child=spawn('npm',args,{cwd:repo,stdio:'inherit',detached:true});children.push(child);child.on('error',()=>stop(1));child.on('exit',code=>{if(!stopping)stop(code??1);});return child;}
async function build(){await new Promise<void>((done,fail)=>{const child=spawn('npm',['run','build','--prefix','apps/web'],{cwd:repo,stdio:'inherit'});child.on('error',fail);child.on('exit',code=>code===0?done():fail(new Error('Frontend build failed')));});}
try{
 await build();
 let installed=true;try{await access(join(paths.root,'installation.json'));}catch{installed=false;}
 if(!installed){const password=randomBytes(18).toString('base64url');await bootstrap(data,{username:'admin',displayName:'Администратор',password,publicUrl:origin});await writeFile(join(data,'prototype-private.json'),JSON.stringify({username:'admin',password}),{flag:'wx',mode:0o600});}
 const installation=JSON.parse(await readFile(join(paths.root,'installation.json'),'utf8'));
 if(installation.publicUrl!==origin)throw new Error('Use the port from the existing prototype installation');
 const credentials=JSON.parse(await readFile(join(data,'prototype-private.json'),'utf8'));
 console.info(`\nYourWiki prototype: ${origin}\nЛогин: ${credentials.username}\nПароль: ${credentials.password}\nДанные: ${data}\nCtrl+C останавливает все процессы.\n`);
 start(['--prefix','apps/server','run','start','--',paths.databasePath,paths.storagePath,paths.secretKeyPath,origin,join(repo,'apps/web/dist'),'--port',String(port)]);
 start(['--prefix','apps/server','run','provider-worker','--',paths.databasePath,paths.storagePath,paths.secretKeyPath]);
 let officeRoot:string|undefined;
 for(const candidate of [process.env.YOURWIKI_OFFICE_ROOT,'/usr/lib/libreoffice',join(process.env.HOME??'/nonexistent','.cache/codex-runtimes/codex-primary-runtime/dependencies/native/libreoffice-headless/libreoffice')]){if(!candidate)continue;try{await access(join(candidate,'program','soffice.bin'));officeRoot=candidate;break;}catch{}}
 start(['--prefix','apps/server','run','worker','--',paths.databasePath,paths.storagePath,...officeRoot?['--office-root',officeRoot]:[]]);
}catch(error){console.error(error instanceof Error?error.message:'Prototype startup failed');stop(1);}
