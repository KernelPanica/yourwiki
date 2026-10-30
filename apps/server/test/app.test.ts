import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';

// Tests pin externally visible recovery behavior, not Fastify internals.
test('liveness does not claim readiness to serve workspace data', async t => {
  const app = buildApp(); t.after(() => app.close());
  const health = await app.inject('/health/');
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: 'ok', service: 'yourwiki' });
  const ready = await app.inject('/ready/');
  assert.equal(ready.statusCode, 503);
  assert.equal(ready.json().code, 'NOT_READY');
});

test('readiness only succeeds when its local dependency check succeeds', async t => {
  let ready = false;
  const app = buildApp({ readiness: async () => ready }); t.after(() => app.close());
  assert.equal((await app.inject('/ready/')).statusCode, 503);
  ready = true;
  const response = await app.inject('/ready/');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ready' });
});

test('failed readiness check is a safe unavailable response', async t => {
  const app = buildApp({ readiness: async () => { throw new Error('secret-database-password'); } });
  t.after(() => app.close());
  const response = await app.inject('/ready/');
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, 'NOT_READY');
  assert.ok(!response.body.includes('secret-database-password'));
});

test('unknown routes do not echo secret query strings and have correlated errors', async t => {
  const app = buildApp(); t.after(() => app.close());
  const response = await app.inject({ url: '/private?access_token=secret-token', headers: { 'x-request-id': 'forged' } });
  assert.equal(response.statusCode, 404);
  const error = response.json();
  assert.equal(error.code, 'NOT_FOUND');
  assert.equal(error.retryable, false);
  assert.equal(error.operationId, null);
  assert.deepEqual(error.recoveryActions, []);
  assert.deepEqual(error.fieldErrors, {});
  assert.match(error.requestId, /^[0-9a-f-]{36}$/);
  assert.notEqual(error.requestId, 'forged');
  assert.equal(response.headers['x-request-id'], error.requestId);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(!response.body.includes('secret-token'));
});

test('unexpected errors do not expose internals or encourage unsafe retries', async t => {
  const app = buildApp(); t.after(() => app.close());
  app.post('/failing', async () => { throw new Error('secret-provider-key'); });
  const response = await app.inject({ method: 'POST', url: '/failing' });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().code, 'INTERNAL_ERROR');
  assert.equal(response.json().retryable, false);
  assert.ok(!response.body.includes('secret-provider-key'));
});

test('malformed JSON and oversized requests have actionable structured errors', async t => {
  const app = buildApp(); t.after(() => app.close());
  app.post('/input', async () => ({ accepted: true }));
  const malformed = await app.inject({ method: 'POST', url: '/input',
    headers: { 'content-type': 'application/json' }, payload: '{"secret":' });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().code, 'INVALID_REQUEST');
  const large = await app.inject({ method: 'POST', url: '/input',
    headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ value: 'x'.repeat(1024 * 1024) }) });
  assert.equal(large.statusCode, 413);
  assert.equal(large.json().code, 'PAYLOAD_TOO_LARGE');
  assert.equal(large.json().retryable, false);
});


test('unsupported media type is a client error, not an internal server failure', async t => {
  const app = buildApp(); t.after(() => app.close());
  app.post('/input', async () => ({ accepted: true }));
  const response = await app.inject({ method: 'POST', url: '/input',
    headers: { 'content-type': 'application/x-unknown' }, payload: 'input' });
  assert.equal(response.statusCode, 415);
  assert.equal(response.json().code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('schema validation failures do not return raw request values', async t => {
  const app = buildApp(); t.after(() => app.close());
  app.post('/validated', { schema: { body: { type: 'object', required: ['title'],
    properties: { title: { type: 'string', maxLength: 3 } } } } }, async () => ({ accepted: true }));
  const response = await app.inject({ method: 'POST', url: '/validated', payload: { title: 'secret-value' } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'INVALID_REQUEST');
  assert.ok(!response.body.includes('secret-value'));
});
