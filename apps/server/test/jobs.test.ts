import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.ts';
import { JobQueue } from '../src/jobs.ts';
function fixture(t: any) { const db = openDatabase(':memory:'); t.after(() => db.close()); return new JobQueue(db); }
const task = { kind: 'preview.prepare', key: 'doc:1', payload: { documentId: 'doc', revision: 1 } };

test('deduplication is durable and rejects mismatched work under the same key', t => {
  const queue = fixture(t);
  const id = queue.enqueue(task, 1000);
  assert.equal(queue.enqueue({ ...task, payload: { revision: 1, documentId: 'doc' } }, 1001), id);
  assert.throws(() => queue.enqueue({ ...task, payload: { revision: 2 } }, 1002), /different|mismatch/i);
  const claim = queue.claim(1000, 100)!;
  assert.equal(claim.id, id); assert.equal(claim.reclaimed, false);
  assert.equal(queue.complete(claim, 1001), true);
  assert.equal(queue.enqueue(task, 1002), id);
  assert.equal(queue.claim(1003), null);
});

test('expired claims are fenced and flagged for recovery before replay', t => {
  const queue = fixture(t); queue.enqueue(task, 1000);
  const old = queue.claim(1000, 10)!;
  assert.equal(queue.claim(1009), null);
  const current = queue.claim(1010, 100)!;
  assert.equal(current.reclaimed, true); assert.notEqual(current.token, old.token);
  assert.equal(queue.complete(old, 1011), false);
  assert.equal(queue.renew(old, 1011, 100), false);
  assert.equal(queue.fail(old, 'OLD_WORKER', 1011, 0), false);
  assert.equal(queue.complete(current, 1011), true);
});

test('retry delay, lease renew and maximum attempts survive failures', t => {
  const queue = fixture(t); queue.enqueue({ ...task, maxAttempts: 2 }, 1000);
  const first = queue.claim(1000, 20)!;
  assert.equal(queue.renew(first, 1010, 100), true);
  assert.equal(queue.claim(1020), null);
  assert.equal(queue.fail(first, 'CONVERSION_FAILED', 1021, 100), true);
  assert.equal(queue.claim(1120), null);
  const second = queue.claim(1121, 10)!;
  assert.equal(second.attempts, 2);
  assert.equal(queue.fail(second, 'CONVERSION_FAILED', 1122, 0), true);
  assert.equal(queue.claim(1200), null);
});

test('last expired attempt becomes terminal, never an infinite requeue', t => {
  const queue = fixture(t); queue.enqueue({ ...task, maxAttempts: 1 }, 1000);
  const claim = queue.claim(1000, 10)!;
  assert.equal(queue.complete(claim, 1010), false);
  assert.equal(queue.claim(1010), null);
  assert.equal(queue.status(claim.id)!.state, 'failed');
});

test('work remains claimable after reopening the database', t => {
  const root = mkdtempSync(join(tmpdir(), 'yourwiki-jobs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'v2.sqlite3');
  let db = openDatabase(path); new JobQueue(db).enqueue(task, 1000); db.close();
  db = openDatabase(path); t.after(() => db.close());
  assert.equal(new JobQueue(db).claim(1001)!.kind, 'preview.prepare');
});
