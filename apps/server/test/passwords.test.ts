import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from '../src/auth/passwords.ts';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/django-passwords.json', import.meta.url), 'utf8'));

for (const [algorithm, hash] of Object.entries(fixture.hashes)) {
  test(`verifies real Django ${algorithm} Unicode passwords without reset`, async () => {
    assert.equal(await verifyPassword(fixture.password, hash as string), true);
    assert.equal(await verifyPassword('wrong', hash as string), false);
  });
}

test('new passwords have distinct salts and verify without storing plaintext', async () => {
  const first = await hashPassword('a long correct password');
  const second = await hashPassword('a long correct password');
  assert.notEqual(first, second);
  assert.ok(!first.includes('a long correct password'));
  assert.equal(await verifyPassword('a long correct password', first), true);
  assert.equal(await verifyPassword('wrong', first), false);
});

test('malformed, unsupported, unusable and excessive KDF hashes fail closed', async () => {
  for (const hash of ['', '!unusable', 'unknown$hash', 'md5$salt$hash',
    'pbkdf2_sha256$999999999$salt$aGVsbG8=', 'pbkdf2_sha256$0$salt$aA==',
    'pbkdf2_sha256$1200$salt$!', 'scrypt$1073741824$salt$8$1$abc']) {
    assert.equal(await verifyPassword('password', hash), false, hash);
  }
});
