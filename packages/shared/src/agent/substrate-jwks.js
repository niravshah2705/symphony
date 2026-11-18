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
 *
 * A key set is only ever cached when it is a non-empty array. `keys: []` used to
 * be stored like any other response, and verifyActorJwt treated an empty set as
 * "nothing to check" — so one 200-without-keys from the endpoint (a proxy stub, a
 * mid-restart ate-idp, an HTML error page served as JSON) silently turned actor
 * auth off for the whole TTL. Serving a stale good set for a short window keeps a
 * transient endpoint fault from rejecting real actors; past that window the only
 * honest answer is an error, because a key set we cannot refresh is also a key set
 * we cannot rotate into.
 */
const log = require('@ai-fleet/shared/logger');

const STALE_GRACE_MS = 60 * 1000;

let cache = { url: null, keys: null, fetchedAt: 0 };

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

/** Last-good keys, still within TTL + grace. Null when there is nothing to serve. */
function usableStale({ url, ttlMs, staleGraceMs, now }) {
  if (cache.url !== url || !cache.keys || !cache.keys.length) return null;
  return now - cache.fetchedAt < ttlMs + staleGraceMs ? { keys: cache.keys } : null;
}

async function getJwks({
  url = process.env.SUBSTRATE_JWKS_URL,
  ttlMs = 5 * 60 * 1000,
  staleGraceMs = STALE_GRACE_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!url) {
    fail('jwks_unconfigured', 'SUBSTRATE_JWKS_URL is not set; cannot verify substrate actor JWTs.');
  }
  const now = Date.now();
  if (cache.url === url && cache.keys && cache.keys.length && now - cache.fetchedAt < ttlMs) {
    return { keys: cache.keys };
  }
  // The refresh failed in whatever way it failed — unreachable, non-2xx, or a body
  // that is not a JWKS. Fall back to the last set that actually verified something.
  const recovered = (reason) => {
    const stale = usableStale({ url, ttlMs, staleGraceMs, now });
    if (stale) {
      log.warn(`substrate JWKS refresh failed (${reason}); serving ${stale.keys.length} cached key(s) within the grace window`);
      return stale;
    }
    fail('jwks_empty', 'the substrate JWKS endpoint yielded no usable signing keys and no cached set is fresh enough to fall back on; refusing to verify actor JWTs');
  };

  let res;
  let body;
  try {
    res = await fetchImpl(url);
    if (res.ok) body = await res.json();
  } catch (err) {
    return recovered(`fetch threw ${err && err.message || err}`);
  }
  if (!res.ok) return recovered(`fetch failed (${res.status})`);

  const keys = Array.isArray(body && body.keys) ? body.keys : [];
  if (!keys.length) return recovered('body carried no keys');
  cache = { url, keys, fetchedAt: now };
  return { keys: cache.keys };
}

function _resetCache() {
  cache = { url: null, keys: null, fetchedAt: 0 };
}

module.exports = { getJwks, _resetCache };
