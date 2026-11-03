import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {mkdir,readFile} from 'node:fs/promises';
import {createBackup,restoreBackup,verifyBackup} from './backup.ts';
import {startSetup} from './setup.ts';
import {ensureFreshRoot} from './workspace.ts';
import {migrateLegacy} from './legacy.ts';
const args=process.argv.slice(2),locked=args[0]==='--locked';if(locked)args.shift();
try{
 const [command,...values]=args;
 if(command==='verify-backup'&&values.length===1){const result=await verifyBackup(resolve(values[0]));console.info(JSON.stringify({status:'verified',files:result.files.length}));}
 else if(['setup','backup','restore','migrate'].includes(command)&&values.length>=1){
  const root=resolve(values[0]);await mkdir(root,{recursive:true,mode:0o700});
  if(!locked){const child=spawn('flock',['--exclusive','--nonblock','--no-fork',join(root,'release.lock'),process.execPath,import.meta.filename,'--locked',command,root,...values.slice(1)],{stdio:'inherit'});process.once('SIGTERM',()=>child.kill('SIGTERM'));process.once('SIGINT',()=>child.kill('SIGINT'));process.exitCode=await new Promise<number>((done,reject)=>{child.once('error',reject);child.once('exit',code=>done(code??1));});}
  else if(command==='setup'&&values.length===1){await startSetup(root,Number(process.env.SETUP_PORT??3100),process.env.SETUP_BIND??'127.0.0.1',process.env.SETUP_BROWSER_URL);}
  else if(command==='backup'&&values.length===2)console.info(JSON.stringify(await createBackup(join(root,'workspace'),resolve(values[1]))));
  else if(command==='restore'&&values.length===2){await ensureFreshRoot(root);console.info(JSON.stringify(await restoreBackup(resolve(values[1]),join(root,'workspace'))));}
  else if(command==='migrate'&&values.length===2){await ensureFreshRoot(root);console.info(JSON.stringify(await migrateLegacy(root,JSON.parse(await readFile(resolve(values[1]),'utf8')))));}
  else throw new Error('INVALID_ARGUMENTS');
 }else throw new Error('INVALID_ARGUMENTS');
}catch(error){const allowed=['EXISTING_DATA','DESTINATION_EXISTS','BACKUP_CHECKSUM_MISMATCH','INCOMPLETE_BACKUP','INVALID_ARGUMENTS','CUTOVER_BLOCKED'];const message=error instanceof Error&&allowed.includes(error.message)?error.message:'RELEASE_OPERATION_FAILED';console.error(`${message}. Usage: npm run release -- setup DATA_ROOT | backup DATA_ROOT DESTINATION | restore DATA_ROOT BACKUP | verify-backup BACKUP | migrate DATA_ROOT INPUT_JSON. Stop all runtime services first.`);process.exitCode=1;}
