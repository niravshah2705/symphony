'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  createStreamTokenService,
  TTL_MS,
  CLOCK_SKEW_MS,
  MAX_TOKEN_FUTURE_MS,
} = require('./stream-token');

const NOW = 1_800_000_000_000;
const SECRET = 'test-stream-token-secret';

function signedToken(channelId, expiresAt, context = {}, expiryPrefix = String(expiresAt)) {
  const organizationId = String(context.organizationId || '').trim();
  const projectId = String(context.projectId || '').trim();
  const signature = crypto.createHmac('sha256', SECRET)
    .update(`${channelId}.${expiresAt}.${organizationId}.${projectId}`)
    .digest('base64url');
  return `${expiryPrefix}.${signature}`;
}

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

test('verify accepts clock-skew-compatible tokens and rejects a correctly signed far-future token', () => {
  const context = { organizationId: 'org-1', projectId: 'project-1' };
  const verifier = createStreamTokenService({ secret: SECRET, now: () => NOW });
  const aheadSigner = createStreamTokenService({
    secret: SECRET,
    now: () => NOW + CLOCK_SKEW_MS,
  });
  const skewed = aheadSigner.mint('conversation-1', context);
  assert.equal(skewed.expiresAt, NOW + MAX_TOKEN_FUTURE_MS);
  assert.equal(verifier.verify(skewed.token, 'conversation-1', context), true);

  const farFuture = NOW + MAX_TOKEN_FUTURE_MS + 1;
  const forged = signedToken('conversation-1', farFuture, context);
  assert.equal(verifier.verify(forged, 'conversation-1', context), false);
});

test('verify requires one canonical safe-integer expiry segment', () => {
  const service = createStreamTokenService({ secret: SECRET, now: () => NOW });
  const expiresAt = NOW + TTL_MS;
  assert.equal(service.verify(
    signedToken('conversation-1', expiresAt, {}, `0${expiresAt}`),
    'conversation-1',
  ), false);
  assert.equal(service.verify(
    signedToken('conversation-1', expiresAt, {}, `${expiresAt}e0`),
    'conversation-1',
  ), false);
  assert.equal(service.verify(
    `${signedToken('conversation-1', expiresAt)}.extra`,
    'conversation-1',
  ), false);

  const unsafeExpiry = Number.MAX_SAFE_INTEGER + 1;
  const highNow = Number.MAX_SAFE_INTEGER - 100;
  const highClockService = createStreamTokenService({ secret: SECRET, now: () => highNow });
  assert.equal(highClockService.verify(
    signedToken('conversation-1', unsafeExpiry),
    'conversation-1',
  ), false);
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
