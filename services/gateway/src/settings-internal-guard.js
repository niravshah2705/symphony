'use strict';

/**
 * Guard for the settings-policy reverse proxy.
 *
 * The settings service exposes `/api/v1/internal/*` and `/api/v1/operator/*`
 * surfaces for privileged S2S/operator access, including unmasked credentials.
 * The gateway is the ONLY browser-facing origin and it
 * rewrites `/api/settings-policy/*` → `/api/v1/*`, so without this guard a
 * browser could reach the unmasked surface at
 * `/api/settings-policy/internal/effective-config`. This middleware 404s any
 * request whose path contains an `internal` or `operator` segment, so secrets
 * can never leave over a browser-reachable route. The planner/gateway reach the
 * internal endpoint server-side via settings-client.js, never through here.
 */

function canonicalPath(pathname) {
  let current = String(pathname || '').split('?', 1)[0];
  // Decode repeatedly so both encoded separators/letters and double-encoded
  // variants are compared in the same representation the downstream router
  // may eventually see. Bound the loop to keep the guard cheap and deterministic.
  for (let depth = 0; depth < 4; depth += 1) {
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch (_) {
      return null;
    }
    if (decoded === current) return decoded;
    current = decoded;
  }
  // More remaining percent escapes are ambiguous across proxy/router layers;
  // refuse them instead of guessing at downstream normalization.
  return /%[0-9a-f]{2}/i.test(current) ? null : current;
}

/** True when a request path targets or ambiguously encodes a privileged surface. */
function isInternalPath(pathname) {
  const canonical = canonicalPath(pathname);
  if (canonical === null) return true;
  return /(^|\/)(?:internal|operator)(\/|$)/i.test(canonical);
}

/** Express middleware: 404 any browser request to a privileged surface. */
function blockInternalProxy(req, res, next) {
  // `req.path` can preserve percent escapes while the proxy forwards
  // `originalUrl`; inspect the original raw path and canonicalize exactly once
  // at this trust boundary before any downstream decoder sees it.
  if (isInternalPath(req.originalUrl || req.path)) {
    return res.status(404).json({ error: 'Not found.' });
  }
  return next();
}

module.exports = { canonicalPath, isInternalPath, blockInternalProxy };
