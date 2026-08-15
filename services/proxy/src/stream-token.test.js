'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createStreamTokenService, TTL_MS } = require('./stream-token');

const NOW = 1_800_000_000_000;
const SECRET = 'test-stream-token-secret';

test('mint preserves the legacy token format, HMAC input, and five-minute TTL', () => {
  const service = createStreamTokenService({ secret: SECRET, now: () => NOW });
  const context = { organizationId: 'org-1', projectId: 'project-1' };
  const minted = service.mint('conversation-1', context);
  const expiresAt = NOW + (5 * 60 * 1000);
  const signature = crypto.createHmac('sha256', SECRET)
    .update(`conversation-1.${expiresAt}.org-1.project-1`)
    .digest('base64url');

  assert.equal(TTL_MS, 300_000);
  assert.deepEqual(minted, {
    token: `${expiresAt}.${signature}`,
    expiresAt,
  });
});

test('verify accepts a matching token and rejects expiry/channel/context mismatch', () => {
  let now = NOW;
  const service = createStreamTokenService({ secret: SECRET, now: () => now });
  const context = { organizationId: 'org-1', projectId: 'project-1' };
  const { token, expiresAt } = service.mint('conversation-1', context);

  assert.equal(service.verify(token, 'conversation-1', context), true);
  assert.equal(service.verify(token, 'conversation-2', context), false);
  assert.equal(service.verify(token, 'conversation-1', { ...context, projectId: 'project-2' }), false);
  assert.equal(service.verify(token, 'conversation-1'), false);
  now = expiresAt + 1;
  assert.equal(service.verify(token, 'conversation-1', context), false);
});

test('verify rejects empty and malformed tokens without throwing', () => {
  const service = createStreamTokenService({ secret: SECRET, now: () => NOW });
  for (const token of ['', null, 'abc', '123.bad-signature']) {
    assert.equal(service.verify(token, 'conversation-1'), false);
  }
  assert.equal(service.verify(service.mint('conversation-1').token, ''), false);
});

test('stream-token capability fails closed without a signing secret', () => {
  assert.throws(
    () => createStreamTokenService({ secret: '', now: () => NOW }),
    /STREAM_TOKEN_SECRET is required/,
  );
});
