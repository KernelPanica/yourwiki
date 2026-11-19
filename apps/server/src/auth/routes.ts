import {PasswordResets} from './password-reset.ts';
import {DocumentError} from '../document-errors.ts';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../database.ts';
import { transaction } from '../database.ts';
import { errorEnvelope } from '../errors.ts';
import { authenticateSession, createSession, csrfForToken, revokeSession, validCsrf } from './sessions.ts';
import { verifyPassword } from './passwords.ts';

const cookieName = 'yourwiki_v2_session';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Settings = { session_hours: number; login_attempts: number; login_window_minutes: number };
// A valid PBKDF2 encoding ensures absent accounts still incur password work.
const dummy = 'pbkdf2_sha256$1000000$dummy-login-salt$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

type User = { id: string; password_hash: string; auth_version: number; active: number };
export const sessionCookieHeader=(origin:string,token:string,age:number)=>`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${origin.startsWith('https:')?'; Secure':''}`;
export function sessionCookie(request: FastifyRequest): string {
  const values = (request.headers.cookie ?? '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(cookieName + '='));
  return values.length === 1 ? values[0].slice(cookieName.length + 1) : '';
}

export function registerAuth(app: FastifyInstance, db: Database, publicUrl: string, features: {yourspace?:string;providerStorage?:boolean;providerBackups?:boolean;googleConnect?:boolean;googleDiscovery?:boolean;googleImport?:boolean;googleTrash?:boolean;googleIdentity?:boolean;googleLifecycle?:boolean} = {}): void {
  const url = new URL(publicUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Public URL must be an HTTP(S) origin');
  const origin = url.origin;
  const cookieValue = (token: string, age: number) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${url.protocol === 'https:' ? '; Secure' : ''}`;
  const sameOrigin = (request: FastifyRequest) => request.headers.origin === origin;

  app.post<{ Body: { username: string; password: string } }>('/api/auth/login', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['username', 'password'],
      properties: { username: { type: 'string', minLength: 1, maxLength: 150 }, password: { type: 'string', minLength: 1, maxLength: 1024 } } } },
  }, async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send(errorEnvelope('CSRF_REJECTED', request.id));
    const now = Date.now();
    const settings = db.prepare('SELECT session_hours,login_attempts,login_window_minutes FROM app_state WHERE id=1').get() as Settings;
    const windowMs = settings.login_window_minutes * 60_000;
    const keys = [hash('account:' + request.body.username.toLowerCase()), hash('ip:' + request.ip)];
    const retryAfter = transaction(db, () => {
      db.prepare('DELETE FROM login_attempts WHERE window_start<=?').run(now - windowMs);
      for (const [index, key] of keys.entries()) {
        const row = db.prepare('SELECT attempts,window_start FROM login_attempts WHERE key=?').get(key) as { attempts: number; window_start: number } | undefined;
        if (row && row.attempts >= (index === 0 ? settings.login_attempts : Math.max(100, settings.login_attempts * 10))) return Math.max(1, Math.ceil((row.window_start + windowMs - now) / 1000));
      }
      for (const key of keys) db.prepare(`INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?)
        ON CONFLICT(key) DO UPDATE SET attempts=attempts+1`).run(key, now);
      return 0;
    });
    if (retryAfter) return reply.header('retry-after', retryAfter).code(429).send(errorEnvelope('RATE_LIMITED', request.id));
    const user = db.prepare('SELECT id,password_hash,auth_version,active FROM users WHERE username=?').get(request.body.username) as User | undefined;
    const matched = await verifyPassword(request.body.password, user?.active ? user.password_hash : dummy);
    const session = transaction(db, () => {
      if (!matched || !user || !user.active) return null;
      const fresh = db.prepare('SELECT password_hash,auth_version,active FROM users WHERE id=?').get(user.id) as User | undefined;
      if (!fresh?.active || fresh.auth_version !== user.auth_version || fresh.password_hash !== user.password_hash) return null;
      const current = db.prepare('SELECT session_hours FROM app_state WHERE id=1').get() as Settings;
      const value = createSession(db, user.id, Date.now(), current.session_hours * 3600_000);
      db.prepare('DELETE FROM login_attempts WHERE key=?').run(keys[0]);
      return value;
    });
    if (!session) return reply.code(401).send(errorEnvelope('INVALID_CREDENTIALS', request.id));
    revokeSession(db, sessionCookie(request));
    return reply.header('set-cookie', cookieValue(session.token, session.maxAge)).send({ csrf: session.csrf, expiresAt: session.expiresAt });
  });

  app.post('/api/auth/reset-password',{bodyLimit:16384},async(request,reply)=>{
    if(!sameOrigin(request))return reply.code(403).send(errorEnvelope('CSRF_REJECTED',request.id));
    try{const resets=new PasswordResets(db);resets.attempt(request.ip);const body=request.body as Record<string,unknown>;if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['token','password','passwordConfirmation'].includes(key)))throw new DocumentError('INVALID_REQUEST');return await resets.redeem(body.token,body.password,body.passwordConfirmation);}catch(error){if(!(error instanceof DocumentError))throw error;return reply.code(error.code==='RATE_LIMITED'?429:400).send(errorEnvelope(error.code,request.id));}
  });

  const processNotes = () => db.prepare('SELECT topic,ru,en,link FROM onboarding_process ORDER BY topic').all();
  app.put<{Body:{topic:string;ru:string;en:string;link:string}}>('/api/admin/onboarding/process',{
    bodyLimit:8192,
    schema:{body:{type:'object',additionalProperties:false,required:['topic','ru','en','link'],properties:{
      topic:{enum:['document','denied','permissions','trash']},
      ru:{type:'string',maxLength:500},en:{type:'string',maxLength:500},link:{type:'string',maxLength:1024},
    }}},
  },(request,reply)=>{
    const actor=authenticateSession(db,sessionCookie(request)),csrf=request.headers['x-csrf-token'];
    if(!actor)return reply.code(401).send(errorEnvelope('SESSION_REQUIRED',request.id));
    if(actor.adminRole==='member')return reply.code(403).send(errorEnvelope('ACCESS_DENIED',request.id));
    if(!sameOrigin(request)||typeof csrf!=='string'||!validCsrf(actor,csrf))return reply.code(403).send(errorEnvelope('CSRF_REJECTED',request.id));
    const {topic}=request.body,ru=request.body.ru.trim(),en=request.body.en.trim(),link=request.body.link.trim();
    if(!ru&&!en&&!link)db.prepare('DELETE FROM onboarding_process WHERE topic=?').run(topic);
    else {
      let target:URL|undefined;
      try{target=new URL(link,origin);}catch{/* Invalid links are rejected below. */}
      if(!ru||!en||!target||target.origin!==origin||target.protocol!==url.protocol||target.username||target.password||!/^\/documents\/[^/]+$/.test(target.pathname))
        return reply.code(400).send(errorEnvelope('INVALID_REQUEST',request.id));
      db.prepare('INSERT INTO onboarding_process(topic,ru,en,link) VALUES(?,?,?,?) ON CONFLICT(topic) DO UPDATE SET ru=excluded.ru,en=excluded.en,link=excluded.link')
        .run(topic,ru,en,target.pathname+target.search+target.hash);
    }
    return processNotes();
  });

  app.get('/api/account', async (request, reply) => {
    const token = sessionCookie(request), session = authenticateSession(db, token);
    if (!session) return reply.code(401).send(errorEnvelope('SESSION_REQUIRED', request.id));
    const groups = db.prepare('SELECT g.id,g.name FROM groups g JOIN memberships m ON m.group_id=g.id WHERE m.user_id=? ORDER BY g.id').all(session.userId);
    const visibleFeatures={...(features.yourspace?{yourspace:true}:{}),...(features.googleIdentity?{googleIdentity:true}:{}),...(session.adminRole==='giga'?{...(features.providerStorage?{providerStorage:true}:{}),...(features.providerBackups?{providerBackups:true}:{}),...(features.googleLifecycle?{googleLifecycle:true}:{}),...(features.googleConnect?{googleConnect:true}:{}),...(features.googleDiscovery?{googleDiscovery:true}:{}),...(features.googleImport?{googleImport:true}:{})}:{}),...(['giga','simple'].includes(session.adminRole)&&features.googleTrash?{googleTrash:true}:{})};
    const identity=features.yourspace?db.prepare('SELECT subject FROM yourspace_sessions WHERE token_hash=?').get(session.tokenHash) as {subject:string}|undefined:undefined;
    return { onboardingProcess:processNotes(), ...(identity?{yourspace:{issuer:features.yourspace!,profileUrl:features.yourspace!+'/people/'+encodeURIComponent(identity.subject)}}:{}),user: { id: session.userId, username: session.username, displayName: session.displayName, adminRole: session.adminRole, canInvite:(db.prepare('SELECT can_invite FROM users WHERE id=?').get(session.userId) as {can_invite:number}).can_invite===1, groups }, csrf: csrfForToken(token), ...(Object.keys(visibleFeatures).length?{features:visibleFeatures}:{}) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = sessionCookie(request), session = authenticateSession(db, token);
    if (!session) return reply.code(401).send(errorEnvelope('SESSION_REQUIRED', request.id));
    if (!sameOrigin(request) || typeof request.headers['x-csrf-token'] !== 'string' || !validCsrf(session, request.headers['x-csrf-token'])) {
      return reply.code(403).send(errorEnvelope('CSRF_REJECTED', request.id));
    }
    revokeSession(db, token);
    return reply.header('set-cookie', cookieValue('', 0)).code(204).send();
  });
}
