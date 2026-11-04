'use strict';

/**
 * Minimal JWKS cache for substrate actor JWT verification. The substrate
 * `ate-idp-server` publishes per-actor signing keys; the actor must verify
 * the Bearer token presented by the atenet-router before running any plan,
 * otherwise an in-cluster caller could impersonate an actor and get the
 * gateway-injected credential on their outbound calls.
 *
 * SUBSTRATE_JWKS_URL is required in production. `fetchImpl` is injectable so
 * tests can supply a fixture JWKS without a network call.
 */
let cache = { url: null, keys: null, fetchedAt: 0 };

async function getJwks({
  url = process.env.SUBSTRATE_JWKS_URL,
  ttlMs = 5 * 60 * 1000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!url) {
    const err = new Error('SUBSTRATE_JWKS_URL is not set; cannot verify substrate actor JWTs.');
    err.code = 'jwks_unconfigured';
    throw err;
  }
  const now = Date.now();
  if (cache.url === url && cache.keys && now - cache.fetchedAt < ttlMs) {
    return { keys: cache.keys };
  }
  const res = await fetchImpl(url);
  if (!res.ok) {
    const err = new Error(`JWKS fetch failed (${res.status})`);
    err.code = 'jwks_fetch_failed';
    throw err;
  }
  const body = await res.json();
  cache = { url, keys: Array.isArray(body.keys) ? body.keys : [], fetchedAt: now };
  return { keys: cache.keys };
}

function _resetCache() {
  cache = { url: null, keys: null, fetchedAt: 0 };
}

module.exports = { getJwks, _resetCache };
