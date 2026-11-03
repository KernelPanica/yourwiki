import {createHash,randomBytes} from 'node:crypto';
import {transaction,type Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {authenticateSession,validCsrf,type SessionIdentity} from '../auth/sessions.ts';
import {SecretConfigs} from './secret-config.ts';
import {googleFileId} from './google-read-http.ts';
import {assertGoogleAccountProof,type GoogleAccountProof} from './google-account.ts';
import type {GoogleCodeExchange} from './google-code-exchange.ts';
type Actor={sessionToken:string;csrf:string};
export type GoogleConnectResult={connectionId:string;revision:number;completedAt:number};
type Row={state_hash:string;user_id:string;session_hash:string;connection_id:string;connection_revision:number;encrypted_context:string;phase:'pending'|'claimed';created_at:number;expires_at:number};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function fail(code='INVALID_REQUEST'):never{throw new DocumentError(code);}
function redirect(publicUrl:string):string{
 try{const url=new URL(publicUrl);if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error();return url.origin+'/api/admin/google/oauth/callback';}catch{fail('CONFIG_UNAVAILABLE');}
}
/** Private central-account consent state. Does not exchange a code or expose credentials in an HTTP DTO. */
export class GoogleConnectStates{
 private db:Database;private configs:SecretConfigs;private redirectUri:string;private clock:()=>number;
 private leases=new WeakMap<object,{stateHash:string;actor:Actor}>();
 constructor(db:Database,configs:SecretConfigs,publicUrl:string,options:{clock?:()=>number}={}){this.db=db;this.configs=configs;this.redirectUri=redirect(publicUrl);this.clock=options.clock??Date.now;}
 private now(){const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-600000)fail();return now;}
 private actor(input:Actor,now:number):SessionIdentity{
  if(typeof input.sessionToken!=='string'||typeof input.csrf!=='string')fail('SESSION_REQUIRED');const session=authenticateSession(this.db,input.sessionToken,now);if(!session)fail('SESSION_REQUIRED');if(session.adminRole!=='giga')fail('ACCESS_DENIED');if(!validCsrf(session,input.csrf))fail('CSRF_REJECTED');return session;
 }
 private client(id:string,revision:number){
  if(typeof id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)||!Number.isSafeInteger(revision)||revision<1)fail();
  const row=this.db.prepare('SELECT provider,revision,enabled,encrypted_config FROM provider_connections WHERE id=?').get(id) as {provider:string;revision:number;enabled:number;encrypted_config:string}|undefined;if(!row||row.provider!=='google'||!row.enabled)fail('CONFIG_UNAVAILABLE');if(row.revision!==revision)fail('CONFLICT');
  try{const config=this.configs.decrypt(row.encrypted_config),root=googleFileId(config.root),clientId=config.client_id,clientSecret=config.client_secret;if(typeof clientId!=='string'||clientId.length<1||clientId.length>2048||/[^\x21-\x7e]/.test(clientId)||typeof clientSecret!=='string'||clientSecret.length<1||clientSecret.length>65536||/[^\x21-\x7e]/.test(clientSecret))throw new Error();return {clientId,clientSecret,identity:hash(JSON.stringify([root,clientId,clientSecret]))};}catch{fail('CONFIG_UNAVAILABLE');}
 }
 private context(row:Row,session:SessionIdentity){
  try{const value=this.configs.decrypt(row.encrypted_context);if(Object.keys(value).length!==3||typeof value.identity!=='string'||typeof value.verifier!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.verifier)||value.binding!==JSON.stringify([row.state_hash,row.user_id,row.session_hash,row.connection_id,row.connection_revision,this.redirectUri]))throw new Error();const client=this.client(row.connection_id,row.connection_revision);if(client.identity!==value.identity||row.user_id!==session.userId||row.session_hash!==session.tokenHash)throw new Error();return {...client,codeVerifier:value.verifier};}catch(error){if(error instanceof DocumentError&&error.code==='CONFLICT')throw error;fail('CONFIG_UNAVAILABLE');}
 }
 begin(input:Actor&{connectionId:string;baseRevision:number}):{authorizationUrl:string;expiresAt:number}{
  return transaction(this.db,()=>{const now=this.now(),session=this.actor(input,now),client=this.client(input.connectionId,input.baseRevision);
   this.db.prepare('DELETE FROM provider_google_connect_states WHERE state_hash IN (SELECT state_hash FROM provider_google_connect_states WHERE expires_at<=? ORDER BY expires_at,state_hash LIMIT 256)').run(now);
   if((this.db.prepare('SELECT count(*) AS n FROM provider_google_connect_states').get() as {n:number}).n>=256||(this.db.prepare('SELECT count(*) AS n FROM provider_google_connect_states WHERE user_id=?').get(session.userId) as {n:number}).n>=4)fail('CONFLICT');
   const state=randomBytes(32).toString('base64url'),stateHash=hash(state),verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url'),expiresAt=Math.min(now+600000,session.expiresAt);
   let encrypted:string;try{encrypted=this.configs.encrypt({binding:JSON.stringify([stateHash,session.userId,session.tokenHash,input.connectionId,input.baseRevision,this.redirectUri]),identity:client.identity,verifier});}catch{fail('CONFIG_UNAVAILABLE');}
   this.db.prepare("INSERT INTO provider_google_connect_states(state_hash,user_id,session_hash,connection_id,connection_revision,encrypted_context,phase,created_at,expires_at) VALUES(?,?,?,?,?,?,'pending',?,?)").run(stateHash,session.userId,session.tokenHash,input.connectionId,input.baseRevision,encrypted,now,expiresAt);
   const params=new URLSearchParams({client_id:client.clientId,redirect_uri:this.redirectUri,response_type:'code',scope:'https://www.googleapis.com/auth/drive',access_type:'offline',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256'});return {authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?'+params.toString(),expiresAt};
  });
 }
 claim(input:Actor&{state:string}){
  const pinned={sessionToken:input.sessionToken,csrf:input.csrf};if(typeof input.state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.state))fail();const stateHash=hash(input.state);
  transaction(this.db,()=>{const now=this.now(),session=this.actor(pinned,now),row=this.db.prepare('SELECT * FROM provider_google_connect_states WHERE state_hash=?').get(stateHash) as Row|undefined;if(!row||row.phase!=='pending'||row.expires_at<=now||row.user_id!==session.userId||row.session_hash!==session.tokenHash)fail();this.context(row,session);this.db.prepare("UPDATE provider_google_connect_states SET phase='claimed' WHERE state_hash=? AND phase='pending'").run(stateHash);});
  const credentials=()=>transaction(this.db,()=>{const now=this.now(),session=this.actor(pinned,now),row=this.db.prepare('SELECT * FROM provider_google_connect_states WHERE state_hash=?').get(stateHash) as Row|undefined;if(!row||row.phase!=='claimed'||row.expires_at<=now)fail();const client=this.context(row,session);return {clientId:client.clientId,clientSecret:client.clientSecret,codeVerifier:client.codeVerifier,redirectUri:this.redirectUri,connectionId:row.connection_id,revision:row.connection_revision};});
  const lease=Object.freeze({credentials,check:()=>{credentials();}});this.leases.set(lease,{stateHash,actor:pinned});return lease;
 }
 result(input:Actor&{state:string}):GoogleConnectResult|null{
  return transaction(this.db,()=>{const now=this.now(),session=this.actor(input,now);if(typeof input.state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.state))fail();const stateHash=hash(input.state),row=this.db.prepare('SELECT * FROM provider_google_connect_states WHERE state_hash=?').get(stateHash) as Row|undefined;if(!row||row.expires_at<=now||row.user_id!==session.userId||row.session_hash!==session.tokenHash)fail();return this.db.prepare('SELECT connection_id AS connectionId,revision,completed_at AS completedAt FROM provider_google_connect_results WHERE state_hash=?').get(stateHash) as GoogleConnectResult|undefined??null;});
 }
 publish(lease:ReturnType<GoogleConnectStates['claim']>,issued:Awaited<ReturnType<GoogleCodeExchange['exchange']>>,proof:GoogleAccountProof):GoogleConnectResult{
  return transaction(this.db,()=>{const mint=this.leases.get(lease);if(!mint)fail('CONFIG_UNAVAILABLE');const now=this.now(),session=this.actor(mint.actor,now),row=this.db.prepare('SELECT * FROM provider_google_connect_states WHERE state_hash=?').get(mint.stateHash) as Row|undefined;if(!row||row.phase!=='claimed'||row.expires_at<=now)fail();this.context(row,session);assertGoogleAccountProof(proof,this.db,lease,issued);const tokens=issued.credentials();if(proof.connectionId!==row.connection_id||proof.revision!==row.connection_revision||row.connection_revision>=Number.MAX_SAFE_INTEGER)fail('CONFLICT');
   const current=this.db.prepare('SELECT encrypted_config FROM provider_connections WHERE id=? AND revision=? AND enabled=1').get(row.connection_id,row.connection_revision) as {encrypted_config:string}|undefined;if(!current)fail('CONFLICT');let cipher:string;try{const config=this.configs.decrypt(current.encrypted_config);cipher=this.configs.encrypt({...config,refresh_token:tokens.refreshToken,google_account_id:proof.accountId,google_root_id:proof.rootId});}catch{fail('CONFIG_UNAVAILABLE');}
   const revision=row.connection_revision+1;if(this.db.prepare('UPDATE provider_connections SET encrypted_config=?,revision=?,updated_at=? WHERE id=? AND revision=? AND encrypted_config=? AND enabled=1').run(cipher,revision,now,row.connection_id,row.connection_revision,current.encrypted_config).changes!==1)fail('CONFLICT');
   this.db.prepare('INSERT INTO provider_connection_changes(connection_id,revision,created_at) VALUES(?,?,?)').run(row.connection_id,revision,now);this.db.prepare('INSERT INTO provider_google_connect_results(state_hash,connection_id,previous_revision,revision,account_id,root_id,completed_at) VALUES(?,?,?,?,?,?,?)').run(row.state_hash,row.connection_id,row.connection_revision,revision,proof.accountId,proof.rootId,now);return {connectionId:row.connection_id,revision,completedAt:now};
  });
 }
}
