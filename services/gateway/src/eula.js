'use strict';

const { CONFIG } = require('@ai-fleet/shared/config');
const { getEulaUser } = require('@ai-fleet/shared/store');

/**
 * End User License Agreement acceptance gate.
 *
 * "Actual work" (scheduling enrichment, preparing a business, creating a task)
 * is blocked until the caller has accepted the current EULA version. Read-only
 * RAG (knowledge/memory search, routing, troubleshooting) is never gated, so a
 * first-time user can still ask questions. Org members are considered already
 * accepted (the gateway records their acceptance up front — see routes/eula.js
 * and the SPA), so this middleware only ever checks the durable, server-side
 * record. The API — not the UI — is the trust boundary: even if the SPA card is
 * bypassed, the mutation endpoints stay closed until acceptance is recorded.
 */

/**
 * Stable per-user key for the acceptance record, derived ONLY from the verified
 * identity on `req.auth` (never from the request body). In AUTH_MODE=disabled
 * there is no user, so the single local operator shares one key.
 * @param {{ auth?: { user?: { sub?: string, email?: string } } }} req
 * @returns {string}
 */
function eulaUserKey(req) {
  const user = req && req.auth && req.auth.user;
  const id = user && (user.sub || user.email);
  return id ? `user:${String(id).toLowerCase()}` : 'user:__local__';
}

/** A record counts as accepted only when it accepted the CURRENT version. */
function isAcceptedRecord(record, version) {
  return Boolean(record && record.status === 'accepted' && record.version === version);
}

/**
 * Resolve the caller's EULA status. `readUser`/`version` are injectable for tests.
 * @param {object} req
 * @param {{ readUser?: (key: string) => object|null, version?: string }} [deps]
 */
function resolveEulaStatus(req, deps = {}) {
  const readUser = deps.readUser || getEulaUser;
  const version = deps.version || CONFIG.EULA_VERSION;
  const key = eulaUserKey(req);
  const record = readUser(key) || null;
  return {
    key,
    version,
    status: record ? record.status : null,
    acceptedVersion: record ? record.version : null,
    via: record ? record.via : null,
    at: record ? record.at : null,
    accepted: isAcceptedRecord(record, version),
  };
}

/**
 * Route guard: 403 EULA_REQUIRED until the caller has accepted the current EULA.
 * @param {{ readUser?: (key: string) => object|null, version?: string }} [deps]
 */
function requireEulaAccepted(deps = {}) {
  return function gate(req, res, next) {
    if (req.method === 'OPTIONS') return next(); // CORS preflight — never gated
    const status = resolveEulaStatus(req, deps);
    if (status.accepted) return next();
    return res.status(403).json({
      error: 'Accept the End User License Agreement before running this action.',
      code: 'EULA_REQUIRED',
      version: status.version,
    });
  };
}

module.exports = { eulaUserKey, isAcceptedRecord, resolveEulaStatus, requireEulaAccepted };
