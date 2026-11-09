/** Isolated plugin UI fixture: no production paths or credentials. */
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {openDatabase} from '../../src/database.ts';
import {buildApp} from '../../src/app.ts';
import {hashPassword} from '../../src/auth/passwords.ts';
import {FernetCodec} from '../../src/providers/fernet.ts';
import {SecretConfigs} from '../../src/providers/secret-config.ts';
const db=openDatabase(':memory:'),codec=new FernetCodec(randomBytes(32).toString('base64url'));
db.prepare("INSERT INTO users(id,username,display_name,password_hash,admin_role) VALUES('qa','qa','Plugin tester',?,'giga')").run(await hashPassword('yourwiki-qa'));
const origin='http://127.0.0.1:39111',app=buildApp({database:db,contentSecrets:new SecretConfigs(codec),webRoot:join(import.meta.dirname,'../../../web/dist'),publicUrl:origin});
app.get('/testing/service',async request=>({connected:true,authorization:request.headers.authorization??null}));
await app.listen({host:'127.0.0.1',port:39111});console.log(JSON.stringify({origin}));
process.once('SIGTERM',async()=>{await app.close();db.close();codec.close();process.exit(0);});
