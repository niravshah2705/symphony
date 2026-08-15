'use strict';

const { CONFIG } = require('@ai-fleet/shared-core/config');

/**
 * CORS for the GCS-hosted SPA calling the gateway API cross-origin.
 *
 * Per the cors-misconfig checklist: reflect ONLY an explicitly allowlisted
 * origin (CONFIG.GCP.spaOrigins), never `*` together with credentials. Allow the
 * Authorization header (bearer) and the methods the SPA uses, and answer
 * preflight. A no-op when no SPA origins are configured (local same-origin).
 */
function createCorsMiddleware(allowed = CONFIG.GCP.spaOrigins) {
  const allowlist = new Set(allowed || []);
  return function cors(req, res, next) {
    const origin = req.get('origin');
    if (origin && allowlist.has(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.set(
        'Access-Control-Allow-Headers',
        'Authorization,Content-Type,X-AI-Fleet-Organization-Id,X-AI-Fleet-Project-Id,X-AI-Fleet-Llm-Gateway'
      );
      res.set('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      // Preflight: 204 whether or not the origin matched (a non-allowlisted
      // origin simply receives no CORS headers and the browser blocks it).
      return res.status(204).end();
    }
    return next();
  };
}

module.exports = { createCorsMiddleware };
