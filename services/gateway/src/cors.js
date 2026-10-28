'use strict';

const { CONFIG } = require('@ai-fleet/shared-core/config');

/**
 * Returns default allowlisted SPA origins derived from environment configuration,
 * including configured SPA_ORIGIN, GCP project Firebase Hosting domains,
 * configured Firebase Auth domain, and production platform origins.
 */
function getDefaultAllowedOrigins() {
  const origins = new Set(CONFIG.GCP.spaOrigins || []);
  if (CONFIG.GCP.projectId) {
    origins.add(`https://${CONFIG.GCP.projectId}.web.app`);
    origins.add(`https://${CONFIG.GCP.projectId}.firebaseapp.com`);
  }
  if (CONFIG.AUTH && CONFIG.AUTH.authDomain) {
    const domain = CONFIG.AUTH.authDomain.startsWith('http')
      ? CONFIG.AUTH.authDomain
      : `https://${CONFIG.AUTH.authDomain}`;
    origins.add(domain);
  }
  origins.add('https://platform.archagentix.com');
  origins.add('https://archagentix.com');
  origins.add('https://*.archagentix.com');
  return Array.from(origins).filter(Boolean);
}

/**
 * Evaluates whether a given origin is allowed against the allowlist,
 * supporting exact matches and wildcard patterns (e.g. `https://*.archagentix.com`).
 */
function isOriginAllowed(origin, allowlist) {
  if (!origin || typeof origin !== 'string') return false;
  if (allowlist.has(origin)) return true;

  for (const entry of allowlist) {
    if (entry.includes('*')) {
      const escaped = entry
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*');
      const regex = new RegExp(`^${escaped}$`, 'i');
      if (regex.test(origin)) return true;
    }
  }

  return false;
}

/**
 * CORS for the SPA calling the gateway API cross-origin.
 *
 * Per the cors-misconfig checklist: reflect ONLY an explicitly allowlisted
 * origin (CONFIG.GCP.spaOrigins + trusted platform/Firebase origins), never `*` together with credentials. Allow the
 * Authorization header (bearer) and the methods the SPA uses, and answer
 * preflight. A no-op when no SPA origins are configured (local same-origin).
 */
function createCorsMiddleware(allowed = getDefaultAllowedOrigins()) {
  const allowlist = new Set(allowed || []);
  return function cors(req, res, next) {
    const origin = req.get('origin');
    if (origin && isOriginAllowed(origin, allowlist)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.set(
        'Access-Control-Allow-Headers',
        'Accept,Authorization,Content-Type,X-AI-Fleet-Organization-Id,X-AI-Fleet-Project-Id,X-AI-Fleet-Llm-Gateway,X-AI-Fleet-Notifications,X-AI-Fleet-Api-Docs,X-Requested-With'
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

module.exports = { createCorsMiddleware, getDefaultAllowedOrigins, isOriginAllowed };
