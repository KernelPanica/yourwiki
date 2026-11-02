import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from '../database.ts';

export interface SessionIdentity {
  userId: string; username: string; displayName: string;
  adminRole: 'member' | 'simple' | 'giga';
  csrfHash: string; tokenHash: string; expiresAt: number;
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const capability = () => randomBytes(32).toString('base64url');
export const csrfForToken = (token: string) => createHash('sha256').update('yourwiki:csrf:' + token).digest('base64url');
const isCapability = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);

export function createSession(db: Database, userId: string, now = Date.now(), lifetime = 24 * 3600_000) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 720 * 3600_000) throw new Error('Invalid session lifetime');
  const user = db.prepare('SELECT auth_version FROM users WHERE id=? AND active=1').get(userId) as { auth_version: number } | undefined;
  if (!user) throw new Error('An active account is required');
  const token = capability(), csrf = csrfForToken(token), expiresAt = now + lifetime;
  db.prepare('INSERT INTO sessions(token_hash,csrf_hash,user_id,auth_version,expires_at) VALUES(?,?,?,?,?)')
    .run(tokenHash(token), tokenHash(csrf), userId, user.auth_version, expiresAt);
  return { token, csrf, expiresAt, maxAge: Math.floor(lifetime / 1000) };
}

export function authenticateSession(db: Database, token: string, now = Date.now()): SessionIdentity | null {
  if (!isCapability(token)) return null;
  const row = db.prepare(`SELECT u.id AS userId,u.username,u.display_name AS displayName,
    u.admin_role AS adminRole,s.csrf_hash AS csrfHash,s.token_hash AS tokenHash,s.expires_at AS expiresAt
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 AND u.auth_version=s.auth_version`).get(tokenHash(token), now);
  return row as unknown as SessionIdentity ?? null;
}

export function validCsrf(session: SessionIdentity, csrf: string): boolean {
  if (!isCapability(csrf)) return false;
  const expected = Buffer.from(session.csrfHash, 'hex');
  const actual = Buffer.from(tokenHash(csrf), 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

export function revokeSession(db: Database, token: string): void {
  if (isCapability(token)) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
}
