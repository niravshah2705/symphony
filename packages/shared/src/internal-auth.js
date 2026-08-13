'use strict';

const crypto = require('node:crypto');

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

/**
 * Defense-in-depth for browser-compatible routes hosted by internal services.
 * Cloud Run IAM remains the production edge; direct/local mode has no such
 * edge, so it requires the shared S2S token instead of trusting caller headers.
 */
function internalServiceAuth({
  mode = process.env.MESSAGING_MODE || 'direct',
  internalToken = process.env.INTERNAL_API_TOKEN,
} = {}) {
  // In cloud/PubSub deployments Cloud Run IAM already authenticates the caller
  // before Express. Requiring the shared secret there would expand a sensitive
  // credential into the public gateway solely for redundant app-layer auth.
  if (String(mode).trim().toLowerCase() === 'pubsub') return (req, res, next) => next();
  const expected = String(internalToken || '').trim();
  return function authenticateInternalService(req, res, next) {
    if (!expected) {
      return res.status(503).json({
        error: 'Internal service authentication is not configured.',
        code: 'internal_service_auth_unconfigured',
      });
    }
    const supplied = req && typeof req.get === 'function' ? req.get('x-internal-token') : '';
    if (!constantTimeEqual(supplied, expected)) {
      return res.status(401).json({ error: 'Unauthorized', code: 'internal_service_unauthorized' });
    }
    return next();
  };
}

module.exports = { constantTimeEqual, internalServiceAuth };
