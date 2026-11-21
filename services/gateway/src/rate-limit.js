'use strict';

/**
 * Per-IP rate limiting for the endpoints an unauthenticated visitor can reach.
 *
 * Hand-rolled rather than `express-rate-limit`, for one reason: the limiter has
 * to be a **no-op when auth is disabled**. `trust-proxy.js` sets 0 hops outside
 * Cloud Run, so every local caller presents as `127.0.0.1`, and `npm run test:e2e`
 * boots the real gateway — a library that always counted would 429 the suite on
 * the second spec. A dependency-free module also keeps a security control
 * auditable and keeps the repo's "gateway has no extra runtime deps" posture.
 *
 * The bound is advisory and per-address, not per-person: a corporate NAT or
 * CGNAT puts many visitors behind one IP. The durable limits are the caps in
 * `CONFIG.GUEST_DEMO`; this exists to stop one address hammering the public
 * surface, which is why it is cheap, in-process, and deliberately not shared
 * across instances.
 */

// Each entry is one address's window. Without a ceiling the map itself becomes
// the DoS: a spoofed-source flood would grow it unboundedly. On overflow the
// entry whose window closes soonest is evicted — the one that costs the least
// enforcement to lose.
const MAX_KEYS = 50000;

function retryAfterSeconds(resetAt, now) {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

/**
 * @param {object}  options
 * @param {number}  options.windowMs   fixed window length
 * @param {number}  options.max        requests allowed per window per address
 * @param {boolean} [options.enabled]  false makes every call a pass-through
 * @param {function} [options.now]     clock, injected for tests
 * @param {function} [options.keyFor]  request → bucket key (defaults to req.ip)
 * @param {string}  [options.code]     error code returned on 429
 */
function createIpRateLimit({ windowMs, max, enabled = true, now = Date.now, keyFor = (req) => req.ip, code = 'rate_limited', message = 'Too many requests from this address. Please slow down.' } = {}) {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  const window = Number.isFinite(windowMs) && windowMs > 0 ? Math.floor(windowMs) : 0;
  // A zero window or a zero limit would 429 everything forever; treat that
  // configuration as "not enabled" rather than as a locked-out public site.
  const active = Boolean(enabled) && window > 0 && limit > 0;
  const buckets = new Map();

  function sweep(timestamp) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= timestamp) buckets.delete(key);
    }
  }

  /** The remaining allowance for `key` in the current window (does not consume). */
  function peek(key, timestamp) {
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= timestamp) return limit;
    return Math.max(0, limit - bucket.count);
  }

  const middleware = function rateLimit(req, res, next) {
    if (!active) return next();
    // CORS preflight is never gated — the same posture as every other guard here.
    if (req.method === 'OPTIONS') return next();

    const key = String(keyFor(req) || 'unknown');
    const timestamp = now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= timestamp) {
      // Only sweep on a rollover; this keeps the common path O(1) while bounding
      // the map without a timer that would need clearing on shutdown.
      if (buckets.size >= MAX_KEYS) sweep(timestamp);
      if (buckets.size >= MAX_KEYS) evictSoonestClosing();
      bucket = { count: 0, resetAt: timestamp + window };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    res.set('X-RateLimit-Limit', String(limit));
    res.set('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));

    if (bucket.count > limit) {
      const seconds = retryAfterSeconds(bucket.resetAt, timestamp);
      res.set('Retry-After', String(seconds));
      // no-store matches denyAccess: a throttled answer must not be cached by a
      // shared proxy and served to the next visitor behind the same address.
      res.set('Cache-Control', 'no-store');
      return res.status(429).json({ error: message, code });
    }
    return next();
  };

  function evictSoonestClosing() {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt < oldest) { oldest = bucket.resetAt; oldestKey = key; }
    }
    if (oldestKey !== null) buckets.delete(oldestKey);
  }

  middleware.enabled = active;
  middleware.limit = limit;
  middleware.windowMs = window;
  middleware.peek = peek;
  middleware.size = () => buckets.size;
  middleware.reset = () => buckets.clear();
  return middleware;
}

module.exports = { createIpRateLimit, retryAfterSeconds, MAX_KEYS };
