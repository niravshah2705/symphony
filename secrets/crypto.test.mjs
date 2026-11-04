import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToB64url,
  b64urlToBytes,
  randomBytes,
  shareId,
  importAesKey,
  deriveAesKey,
  encryptShare,
  openKey,
  decryptShare,
  MAX_SECRET_BYTES,
  KEY_CHECK,
} from './crypto.mjs';

test('base64url roundtrip for every length mod 3, no padding', () => {
  for (let n = 0; n < 10; n += 1) {
    const bytes = randomBytes(n);
    const enc = bytesToB64url(bytes);
    assert.doesNotMatch(enc, /=|\+|\//);
    assert.deepEqual([...b64urlToBytes(enc)], [...bytes], 'len ' + n);
  }
});

test('base64url matches Node Buffer reference encoding', () => {
  const bytes = randomBytes(32);
  assert.equal(bytesToB64url(bytes), Buffer.from(bytes).toString('base64url'));
});

test('share ids are url-safe and unguessable', () => {
  const id = shareId();
  assert.equal(id.length, 32); // 24 bytes -> 32 b64url chars
  assert.match(id, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(shareId(), shareId());
});

test('AES-256-GCM share roundtrips under the raw key', async () => {
  const keyMaterial = randomBytes(32);
  const key = await importAesKey(keyMaterial);
  const plaintext = 'ghp_S3cretT0ken-äöü\nsecond line';
  const doc = await encryptShare(plaintext, key, 'raw', null);
  assert.equal(doc.kdf, 'raw');
  assert.equal(doc.salt, null);

  const key2 = await openKey(keyMaterial, null, doc.kdf, doc.salt);
  assert.equal(await decryptShare(doc, key2), plaintext);
});

test('wrong key material fails GCM authentication', async () => {
  const key = await importAesKey(randomBytes(32));
  const doc = await encryptShare('top secret', key, 'raw', null);
  const wrongKey = await importAesKey(randomBytes(32));
  await assert.rejects(decryptShare(doc, wrongKey));
});

test('passphrase mode: fragment material alone is not enough', async () => {
  const keyMaterial = randomBytes(32);
  const salt = randomBytes(16);
  const key = await deriveAesKey(keyMaterial, 'hunter2', salt);
  const doc = await encryptShare('db password', key, 'pbkdf2', salt);
  assert.equal(doc.kdf, 'pbkdf2');

  const reopened = await openKey(keyMaterial, 'hunter2', doc.kdf, doc.salt);
  assert.equal(await decryptShare(doc, reopened), 'db password');

  await assert.rejects(
    decryptShare(doc, await openKey(keyMaterial, 'wrong-pass', doc.kdf, doc.salt))
  );
  assert.throws(() => {
    // synchronous guard: pbkdf2 docs without a passphrase never open
    return openKey(keyMaterial, null, doc.kdf, doc.salt).catch(() => {});
  }, /passphrase/);
});

test('PBKDF2 derivation is deterministic for identical inputs', async () => {
  const km = randomBytes(32);
  const salt = randomBytes(16);
  const a = await deriveAesKey(km, 'pw', salt);
  const b = await deriveAesKey(km, 'pw', salt);
  const doc = await encryptShare('same both ways', a, 'pbkdf2', salt);
  assert.equal(await decryptShare(doc, b), 'same both ways');
});

test('plaintext over the size cap is refused before encryption', async () => {
  const key = await importAesKey(randomBytes(32));
  const tooBig = 'x'.repeat(MAX_SECRET_BYTES + 1);
  await assert.rejects(() => encryptShare(tooBig, key, 'raw', null), /larger/);
  await encryptShare('x'.repeat(MAX_SECRET_BYTES), key, 'raw', null); // boundary ok
});

test('ciphertext stays inside the rules bound for 1 KB plaintext', async () => {
  const key = await importAesKey(randomBytes(32));
  const doc = await encryptShare('y'.repeat(MAX_SECRET_BYTES), key, 'raw', null);
  // rules bound: ciphertext <= 1400 chars (base64url of 1 KB + 16-byte GCM tag)
  assert.ok(doc.ciphertext.length <= 1400, 'got ' + doc.ciphertext.length);
  assert.ok(doc.keyCheck.length <= 64);
});

test('keyCheck sentinel is what decryptShare verifies', async () => {
  const key = await importAesKey(randomBytes(32));
  const doc = await encryptShare('payload', key, 'raw', null);
  assert.ok(doc.keyCheck && doc.keyCheck !== doc.ciphertext);
  assert.equal(KEY_CHECK, 'archagentix-send-v1');
});
