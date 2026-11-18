'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getJwks, _resetCache } = require('./substrate-jwks');

// Never dialed: every test below injects fetchImpl. This is only a cache key, shaped
// like the in-cluster ate-idp-server address the real SUBSTRATE_JWKS_URL points at.
const JWKS_URL = 'http://ate-idp-server.ate-system.svc/.well-known/jwks.json';
const KEY = { kid: 'k1', kty: 'RSA', n: 'abc', e: 'AQAB' };
const jwksResponse = (keys) => async () => ({
  ok: true,
  json: async () => (keys === undefined ? {} : { keys }),
});
const failingResponse = (status = 500) => async () => ({
  ok: false,
  status,
  json: async () => { throw new Error('no body'); },
});

test.beforeEach(() => _resetCache());

test('a configured URL is required before anything can be verified', async () => {
  await assert.rejects(() => getJwks({ url: '' }), (err) => err.code === 'jwks_unconfigured');
});

// This is the shape that used to be cached as a normal answer, and that
// verifyActorJwt then read as "no keys to check against" -> valid: true.
test('a 200 carrying no keys refuses instead of caching an empty set', async () => {
  for (const body of [undefined, [], 'not-a-list', {}]) {
    _resetCache();
    await assert.rejects(
      () => getJwks({ url: JWKS_URL, fetchImpl: jwksResponse(body) }),
      (err) => err.code === 'jwks_empty',
      `body ${JSON.stringify(body)} must not be served as a usable JWKS`,
    );
  }
  // Nothing cached means the next caller cannot be handed the junk either.
  await assert.rejects(
    () => getJwks({ url: JWKS_URL, ttlMs: 60_000, fetchImpl: jwksResponse([]) }),
    (err) => err.code === 'jwks_empty',
  );
});

test('a non-2xx with no cached set refuses', async () => {
  await assert.rejects(
    () => getJwks({ url: JWKS_URL, fetchImpl: failingResponse(503) }),
    (err) => err.code === 'jwks_empty',
  );
});

test('a throwing fetch refuses rather than reporting an empty key set', async () => {
  await assert.rejects(
    () => getJwks({ url: JWKS_URL, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }),
    (err) => err.code === 'jwks_empty',
  );
});

test('a good set is cached for the TTL without re-fetching', async () => {
  let calls = 0;
  const counting = async () => { calls += 1; return { ok: true, json: async () => ({ keys: [KEY] }) }; };
  const first = await getJwks({ url: JWKS_URL, fetchImpl: counting });
  const second = await getJwks({ url: JWKS_URL, fetchImpl: counting });
  assert.deepEqual(second.keys, [KEY]);
  assert.equal(calls, 1, 'the second read must come from the cache');
  assert.equal(first.keys.length, 1);
});

// A brief ate-idp restart must not reject real actors, but serving stale keys is a
// grace window with a hard end — otherwise a permanently broken endpoint would look
// healthy forever and key rotation would silently stop working.
test('a refresh failure serves the last good set inside the grace window', async () => {
  await getJwks({ url: JWKS_URL, ttlMs: 1, fetchImpl: jwksResponse([KEY]) });
  const stale = await getJwks({ url: JWKS_URL, ttlMs: 1, fetchImpl: failingResponse(500) });
  assert.deepEqual(stale.keys, [KEY], 'the last set that actually verified something is served');

  // Past TTL + grace the same failure is fatal, with no further fetch needed to
  // prove it: the cached timestamp is what expires. (The grace window is injected
  // here; the deployed default is 60s, which no test wants to sit through.)
  await new Promise((r) => setTimeout(r, 25));
  await assert.rejects(
    () => getJwks({ url: JWKS_URL, ttlMs: 1, staleGraceMs: 1, fetchImpl: failingResponse(500) }),
    (err) => err.code === 'jwks_empty',
  );
});

test('an empty response does not evict a good cached set', async () => {
  await getJwks({ url: JWKS_URL, ttlMs: 1, fetchImpl: jwksResponse([KEY]) });
  const stale = await getJwks({ url: JWKS_URL, ttlMs: 1, fetchImpl: jwksResponse([]) });
  assert.deepEqual(stale.keys, [KEY], 'a transient keys:[] must not overwrite real keys');
});

test('a different URL never serves another endpoint keys', async () => {
  await getJwks({ url: JWKS_URL, fetchImpl: jwksResponse([KEY]) });
  await assert.rejects(
    () => getJwks({ url: 'http://other-idp.ate-system.svc/.well-known/jwks.json', fetchImpl: jwksResponse([]) }),
    (err) => err.code === 'jwks_empty',
  );
});

test('a refreshed good set replaces the cached one', async () => {
  const KEY2 = { kid: 'k2', kty: 'RSA', n: 'def', e: 'AQAB' };
  await getJwks({ url: JWKS_URL, ttlMs: 1, fetchImpl: jwksResponse([KEY]) });
  await new Promise((r) => setTimeout(r, 5));
  const next = await getJwks({ url: JWKS_URL, ttlMs: 1, fetchImpl: jwksResponse([KEY, KEY2]) });
  assert.deepEqual(next.keys.map((k) => k.kid), ['k1', 'k2'], 'rotation lands in the cache');
});
