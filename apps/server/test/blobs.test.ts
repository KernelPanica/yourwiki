import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { BlobStore } from '../src/storage/blobs.ts';
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'yourwiki-blobs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: await BlobStore.open(root) };
}
async function* chunks(...values: string[]) { for (const value of values) yield Buffer.from(value); }

test('streamed content has stable digest, private bytes and bounded range reads', async t => {
  const { root, store } = await fixture(t);
  const ref = await store.put(chunks('hel', 'lo'), { maxBytes: 5 });
  assert.deepEqual(ref, { digest: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', size: 5 });
  assert.equal((await buffer(await store.read(ref.digest))).toString(), 'hello');
  assert.equal((await buffer(await store.read(ref.digest, { start: 1, end: 3 }))).toString(), 'ell');
  assert.equal(await store.verify(ref), true);
  assert.equal((await stat(join(root, 'blobs', ref.digest.slice(0, 2), ref.digest.slice(2)))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(root, 'staging')), []);
});

test('limit and interrupted source leave no published data or temporary payload', async t => {
  const { root, store } = await fixture(t);
  await assert.rejects(store.put(chunks('too large'), { maxBytes: 2 }), /limit/i);
  async function* broken() { yield Buffer.from('partial'); throw new Error('source disconnected'); }
  await assert.rejects(store.put(broken(), { maxBytes: 100 }), /disconnected/);
  assert.deepEqual(await readdir(join(root, 'staging')), []);
  assert.deepEqual(await readdir(join(root, 'blobs')), []);
});

test('abort stops accepting chunks and cleans staging', async t => {
  const { root, store } = await fixture(t);
  const controller = new AbortController();
  async function* source() { yield Buffer.from('a'); controller.abort(); yield Buffer.from('b'); }
  await assert.rejects(store.put(source(), { maxBytes: 100, signal: controller.signal }), /abort/i);
  assert.deepEqual(await readdir(join(root, 'staging')), []);
});

test('duplicate writes cannot overwrite a damaged immutable blob', async t => {
  const { root, store } = await fixture(t);
  const ref = await store.put(chunks('original'), { maxBytes: 100 });
  assert.deepEqual(await store.put(chunks('original'), { maxBytes: 100 }), ref);
  const path = join(root, 'blobs', ref.digest.slice(0, 2), ref.digest.slice(2));
  await writeFile(path, 'damaged!');
  assert.equal(await store.verify(ref), false);
  await assert.rejects(store.put(chunks('original'), { maxBytes: 100 }), /corrupt/i);
  assert.equal((await readFile(path)).toString(), 'damaged!');
});

test('invalid digest/range cannot reach arbitrary filesystem paths', async t => {
  const { store } = await fixture(t);
  for (const digest of ['../secret', 'a'.repeat(63), 'A'.repeat(64)]) {
    await assert.rejects(store.read(digest), /digest/i);
  }
  const ref = await store.put(chunks('abc'), { maxBytes: 3 });
  for (const range of [{ start: -1, end: 1 }, { start: 2, end: 1 }, { start: 0, end: 3 }]) {
    await assert.rejects(store.read(ref.digest, range), /range/i);
  }
});

test('abort interrupts a stalled source instead of waiting for the next chunk', async t => {
  const { root, store } = await fixture(t);
  const controller = new AbortController();
  let closed = false;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise(() => {}), return: async () => { closed = true; return { done: true, value: undefined }; } };
    },
  };
  const abort = setTimeout(() => controller.abort(), 20);
  let deadline: ReturnType<typeof setTimeout>;
  try {
    await assert.rejects(Promise.race([
      store.put(source, { maxBytes: 100, signal: controller.signal }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('stalled source was not interrupted')), 500); }),
    ]), (error: any) => error.name === 'AbortError');
    assert.equal(closed, true);
    assert.deepEqual(await readdir(join(root, 'staging')), []);
  } finally { clearTimeout(abort); clearTimeout(deadline!); }
});

test('a stalled iterator close cannot retain staging after a size rejection', async t => {
  const { root, store } = await fixture(t);
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() { return {
      next: async () => ({ done: false as const, value: Buffer.from('oversized') }),
      return: () => new Promise(() => {}),
    }; },
  };
  let deadline: ReturnType<typeof setTimeout>;
  try {
    await assert.rejects(Promise.race([
      store.put(source, { maxBytes: 1 }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('cleanup stalled')), 100); }),
    ]), /configured size limit/);
    assert.deepEqual(await readdir(join(root, 'staging')), []);
  } finally { clearTimeout(deadline!); }
});
