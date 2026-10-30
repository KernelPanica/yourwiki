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
function cookie(request: FastifyRequest): string {
  const values = (request.headers.cookie ?? '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(cookieName + '='));
  return values.length === 1 ? values[0].slice(cookieName.length + 1) : '';
}

export function registerAuth(app: FastifyInstance, db: Database, publicUrl: string): void {
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
    revokeSession(db, cookie(request));
    return reply.header('set-cookie', cookieValue(session.token, session.maxAge)).send({ csrf: session.csrf, expiresAt: session.expiresAt });
  });

  app.get('/api/account', async (request, reply) => {
    const token = cookie(request), session = authenticateSession(db, token);
    if (!session) return reply.code(401).send(errorEnvelope('SESSION_REQUIRED', request.id));
    const groups = db.prepare('SELECT g.id,g.name FROM groups g JOIN memberships m ON m.group_id=g.id WHERE m.user_id=? ORDER BY g.id').all(session.userId);
    return { user: { id: session.userId, username: session.username, displayName: session.displayName, adminRole: session.adminRole, groups }, csrf: csrfForToken(token) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = cookie(request), session = authenticateSession(db, token);
    if (!session) return reply.code(401).send(errorEnvelope('SESSION_REQUIRED', request.id));
    if (!sameOrigin(request) || typeof request.headers['x-csrf-token'] !== 'string' || !validCsrf(session, request.headers['x-csrf-token'])) {
      return reply.code(403).send(errorEnvelope('CSRF_REJECTED', request.id));
    }
    revokeSession(db, token);
    return reply.header('set-cookie', cookieValue('', 0)).code(204).send();
  });
}
