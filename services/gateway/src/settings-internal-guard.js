'use strict';

/**
 * Guard for the settings-policy reverse proxy.
 *
 * The settings service exposes an `/api/v1/internal/*` surface that returns
 * UNMASKED provider secrets (e.g. the resolved Gemini API key) for server-side
 * S2S callers only. The gateway is the ONLY browser-facing origin and it
 * rewrites `/api/settings-policy/*` → `/api/v1/*`, so without this guard a
 * browser could reach the unmasked surface at
 * `/api/settings-policy/internal/effective-config`. This middleware 404s any
 * request whose path contains an `internal` segment, so the plaintext secret
 * can never leave over a browser-reachable route. The planner/gateway reach the
 * internal endpoint server-side via settings-client.js, never through here.
 */

/** True when a request path targets the internal (unmasked) settings surface. */
function isInternalPath(pathname) {
  return /(^|\/)internal(\/|$)/i.test(String(pathname || ''));
}

/** Express middleware: 404 any browser request to the internal S2S surface. */
function blockInternalProxy(req, res, next) {
  if (isInternalPath(req.path)) {
    return res.status(404).json({ error: 'Not found.' });
  }
  return next();
}

module.exports = { isInternalPath, blockInternalProxy };
