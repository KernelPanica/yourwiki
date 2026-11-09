import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {mkdir,readFile,mkdtemp,rm,lstat} from 'node:fs/promises';
import {createBackup,restoreBackup,verifyBackup} from './backup.ts';
import {tmpdir} from 'node:os';
import {decryptBackup} from '../backups/archive.ts';
import {startSetup} from './setup.ts';
import {ensureFreshRoot} from './workspace.ts';
import {migrateLegacy} from './legacy.ts';
import {purgeOfflineWorkspace} from '../administration/offline-purge.ts';
const args=process.argv.slice(2),locked=args[0]==='--locked';if(locked)args.shift();
try{
 const [command,...values]=args;
 if(command==='verify-backup'&&values.length===1){const result=await verifyBackup(resolve(values[0]));console.info(JSON.stringify({status:'verified',files:result.files.length}));}
 else if(['setup','backup','restore','restore-encrypted','migrate','purge-trash'].includes(command)&&values.length>=1){
  const root=resolve(values[0]);await mkdir(root,{recursive:true,mode:0o700});
  if(!locked){const child=spawn('flock',['--exclusive','--nonblock','--no-fork',join(root,'release.lock'),process.execPath,import.meta.filename,'--locked',command,root,...values.slice(1)],{stdio:'inherit'});process.once('SIGTERM',()=>child.kill('SIGTERM'));process.once('SIGINT',()=>child.kill('SIGINT'));process.exitCode=await new Promise<number>((done,reject)=>{child.once('error',reject);child.once('exit',code=>done(code??1));});}
  else if(command==='setup'&&values.length===1){await startSetup(root,Number(process.env.SETUP_PORT??3100),process.env.SETUP_BIND??'127.0.0.1',process.env.SETUP_BROWSER_URL);}
  else if(command==='purge-trash'&&values.length===1)console.info(JSON.stringify(await purgeOfflineWorkspace(join(root,'workspace'))));
  else if(command==='backup'&&values.length===2)console.info(JSON.stringify(await createBackup(join(root,'workspace'),resolve(values[1]))));
  else if(command==='restore-encrypted'&&values.length===3){await ensureFreshRoot(root);const secretPath=resolve(values[2]),info=await lstat(secretPath);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||info.size>1024)throw new Error('INVALID_ARGUMENTS');const passphrase=(await readFile(secretPath,'utf8')).replace(/\r?\n$/,'');const temporary=await mkdtemp(join(tmpdir(),'yourwiki-restore-'));try{await decryptBackup(resolve(values[1]),join(temporary,'decoded'),passphrase);console.info(JSON.stringify(await restoreBackup(join(temporary,'decoded'),join(root,'workspace'))));}finally{await rm(temporary,{recursive:true,force:true});}}
  else if(command==='restore'&&values.length===2){await ensureFreshRoot(root);console.info(JSON.stringify(await restoreBackup(resolve(values[1]),join(root,'workspace'))));}
  else if(command==='migrate'&&values.length===2){await ensureFreshRoot(root);const result=await migrateLegacy(root,JSON.parse(await readFile(resolve(values[1]),'utf8')));console.info(JSON.stringify(result));if(result.status==='blocked')process.exitCode=2;}
  else throw new Error('INVALID_ARGUMENTS');
 }else throw new Error('INVALID_ARGUMENTS');
}catch(error){const allowed=['EXISTING_DATA','DESTINATION_EXISTS','BACKUP_CHECKSUM_MISMATCH','INCOMPLETE_BACKUP','INVALID_ARGUMENTS','CUTOVER_BLOCKED'];const message=error instanceof Error&&allowed.includes(error.message)?error.message:'RELEASE_OPERATION_FAILED';console.error(`${message}. Usage: npm run release -- setup DATA_ROOT | backup DATA_ROOT DESTINATION | restore DATA_ROOT BACKUP | verify-backup BACKUP | migrate DATA_ROOT INPUT_JSON | purge-trash DATA_ROOT | restore-encrypted DATA_ROOT ARCHIVE PRIVATE_PASSPHRASE_FILE. Stop all runtime services first.`);process.exitCode=1;}
