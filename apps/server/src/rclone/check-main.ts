import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import Sqlite from 'better-sqlite3';
import {loadSecretCodec} from '../providers/secret-key.ts';
import {SecretConfigs} from '../providers/secret-config.ts';
import {assertRcloneMounted} from '../providers/rclone-mount-guard.ts';
const [workspace,path]=process.argv.slice(2);try{const settings=JSON.parse(await readFile(path,'utf8')),codec=await loadSecretCodec(join(workspace,'encryption.key')),db=new Sqlite(join(workspace,'database.sqlite3'),{readonly:true});try{const row=db.prepare('SELECT enabled,encrypted_config FROM provider_connections WHERE id=?').get(settings.sourceConnectionId) as {enabled:number;encrypted_config:string}|undefined;if(row?.enabled&&new SecretConfigs(codec).decrypt(row.encrypted_config).refresh_token)assertRcloneMounted(settings.mountDir);}finally{db.close();codec.close();}console.info('Rclone startup gate ready');}catch{console.error('Rclone startup gate: required Drive mount unavailable');process.exitCode=1;}
