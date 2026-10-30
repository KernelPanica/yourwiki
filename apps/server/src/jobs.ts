import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { transaction } from './database.ts';
import type { Database } from './database.ts';

export interface ClaimedJob {
  id: string; kind: string; payload: Record<string, unknown>; token: string;
  attempts: number; reclaimed: boolean;
}
type JobRow = { id: string; kind: string; payload: string; state: string; lease_token: string; attempts: number; max_attempts: number };
function time(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid job time'); }
function lease(value: number) { if (!Number.isSafeInteger(value) || value < 1 || value > 3600_000) throw new Error('Invalid job lease'); }

export class JobQueue {
  private db: Database;
  constructor(db: Database) { this.db = db; }

  enqueue(input: { kind: string; key: string; payload: Record<string, unknown>; maxAttempts?: number }, now = Date.now()): string {
    time(now);
    const max = input.maxAttempts ?? 5;
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(input.kind) || !input.key || input.key.length > 512 || !Number.isInteger(max) || max < 1 || max > 100) throw new Error('Invalid job metadata');
    const encoded = JSON.stringify(input.payload);
    if (!encoded || Buffer.byteLength(encoded) > 65536 || !isDeepStrictEqual(JSON.parse(encoded), input.payload)) throw new Error('Invalid JSON job payload');
    return transaction(this.db, () => {
      const previous = this.db.prepare('SELECT id,payload FROM jobs WHERE kind=? AND dedupe_key=?').get(input.kind, input.key) as { id: string; payload: string } | undefined;
      if (previous) {
        if (!isDeepStrictEqual(JSON.parse(previous.payload), input.payload)) throw new Error('Different payload under the same job key');
        return previous.id;
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO jobs(id,kind,dedupe_key,payload,available_at,max_attempts,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, input.kind, input.key, encoded, now, max, now);
      return id;
    });
  }

  claim(now = Date.now(), leaseMs = 30_000): ClaimedJob | null {
    time(now); lease(leaseMs);
    return transaction(this.db, () => {
      this.db.prepare(`UPDATE jobs SET state='failed',lease_token=NULL,lease_until=NULL,error_code='RETRY_EXHAUSTED'
        WHERE attempts>=max_attempts AND (state='queued' OR (state='running' AND lease_until<=?))`).run(now);
      const row = this.db.prepare(`SELECT * FROM jobs WHERE attempts<max_attempts
        AND ((state='queued' AND available_at<=?) OR (state='running' AND lease_until<=?))
        ORDER BY created_at,id LIMIT 1`).get(now, now) as JobRow | undefined;
      if (!row) return null;
      const token = randomUUID();
      this.db.prepare("UPDATE jobs SET state='running',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?")
        .run(token, now + leaseMs, row.id);
      return { id: row.id, kind: row.kind, payload: JSON.parse(row.payload), token, attempts: row.attempts + 1, reclaimed: row.state === 'running' };
    });
  }

  owns(claim: Pick<ClaimedJob, 'id' | 'token'>, now = Date.now()): boolean {
    time(now);
    return !!this.db.prepare("SELECT id FROM jobs WHERE id=? AND state='running' AND lease_token=? AND lease_until>?").get(claim.id, claim.token, now);
  }

  renew(claim: ClaimedJob, now = Date.now(), leaseMs = 30_000): boolean {
    time(now); lease(leaseMs);
    return this.db.prepare("UPDATE jobs SET lease_until=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?")
      .run(now + leaseMs, claim.id, claim.token, now).changes === 1;
  }

  complete(claim: ClaimedJob, now = Date.now()): boolean {
    time(now);
    return this.db.prepare("UPDATE jobs SET state='succeeded',lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=? AND state='running' AND lease_token=? AND lease_until>?")
      .run(claim.id, claim.token, now).changes === 1;
  }

  fail(claim: ClaimedJob, code: string, now = Date.now(), retryDelay = 60_000): boolean {
    time(now);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code) || !Number.isSafeInteger(retryDelay) || retryDelay < 0 || retryDelay > 86400_000) throw new Error('Invalid job failure metadata');
    return this.db.prepare(`UPDATE jobs SET state=CASE WHEN attempts<max_attempts THEN 'queued' ELSE 'failed' END,
      lease_token=NULL,lease_until=NULL,error_code=?,available_at=?
      WHERE id=? AND state='running' AND lease_token=? AND lease_until>?`).run(code, now + retryDelay, claim.id, claim.token, now).changes === 1;
  }

  status(id: string): (Omit<JobRow, 'payload'> & { payload: Record<string, unknown> }) | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    return row ? { ...row, payload: JSON.parse(row.payload) } : null;
  }
}
