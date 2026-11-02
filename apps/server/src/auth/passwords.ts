import { pbkdf2, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(pbkdf2);
const iterations = 1_000_000;

function base64(value: string, length: number): Buffer | null {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === length && decoded.toString('base64') === value ? decoded : null;
}

export async function hashPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password) > 4096) throw new Error('Password exceeds supported size');
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, iterations, 32, 'sha256');
  return `pbkdf2_sha256$${iterations}$${salt}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (Buffer.byteLength(password) > 4096 || encoded.length > 2048) return false;
  const fields = encoded.split('$');
  try {
    if (['pbkdf2_sha256', 'pbkdf2_sha1'].includes(fields[0]) && fields.length === 4) {
      const [algorithm, count, salt, value] = fields;
      const rounds = Number(count);
      const length = algorithm === 'pbkdf2_sha256' ? 32 : 20;
      const expected = base64(value, length);
      if (!/^\d+$/.test(count) || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10_000_000 || !salt || salt.length > 128 || !expected) return false;
      const actual = await derive(password, salt, rounds, length, algorithm === 'pbkdf2_sha256' ? 'sha256' : 'sha1');
      return timingSafeEqual(actual, expected);
    }
    if (fields[0] === 'scrypt' && fields.length === 6) {
      const [, work, salt, block, parallel, value] = fields;
      const N = Number(work), r = Number(block), p = Number(parallel);
      const expected = base64(value, 64);
      if (![work, block, parallel].every(x => /^\d+$/.test(x)) || !Number.isSafeInteger(N) || N < 2 || N > 131072 || (N & (N - 1)) || r < 1 || r > 16 || p < 1 || p > 8 || !salt || salt.length > 128 || !expected) return false;
      const actual = await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, 64, { N, r, p, maxmem: 256 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
      });
      return timingSafeEqual(actual, expected);
    }
  } catch { return false; }
  return false;
}
