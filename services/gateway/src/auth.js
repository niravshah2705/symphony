'use strict';

const { CONFIG } = require('@ai-fleet/shared/config');

const MAX_PAYLOAD_BYTES = 16 * 1024;
const CLOCK_SKEW_SECONDS = 60;

function authError(message) {
  const error = new Error(message);
  error.status = 401;
  error.code = 'authentication_required';
  return error;
}

function authorizationError(message) {
  const error = new Error(message);
  error.status = 403;
  error.code = 'access_denied';
  return error;
}

function decodeVerifiedPayload(value) {
  const encoded = String(value || '').trim();
  if (!encoded || encoded.length > MAX_PAYLOAD_BYTES * 2 || !/^[A-Za-z0-9_+/=-]+$/.test(encoded)) {
    throw authError('Authentication payload is missing or malformed');
  }

  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch (_) {
    throw authError('Authentication payload is malformed');
  }
  if (!decoded || Buffer.byteLength(decoded, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw authError('Authentication payload is malformed');
  }

  let claims;
  try {
    claims = JSON.parse(decoded);
  } catch (_) {
    throw authError('Authentication payload is malformed');
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw authError('Authentication payload is malformed');
  }
  return claims;
}

function boundedClaim(value, maxLength = 320) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n\0]/.test(normalized)) return '';
  return normalized;
}

function claimAudienceIncludes(claim, expected) {
  if (typeof claim === 'string') return claim === expected;
  return Array.isArray(claim) && claim.some((value) => value === expected);
}

function identityFromClaims(claims, config = CONFIG.AUTH, nowMs = Date.now()) {
  if (!config || config.mode !== 'istio') throw authError('Authentication is not configured');
  if (claims.iss !== config.issuer) throw authError('Authentication issuer does not match');
  if (!claimAudienceIncludes(claims.aud, config.audience)) throw authError('Authentication audience does not match');
  if (config.organization && claims.org_id !== config.organization) {
    throw authError('Authentication organization does not match');
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS) {
    throw authError('Authentication has expired');
  }
  if (Number.isFinite(claims.nbf) && claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw authError('Authentication is not active yet');
  }

  const sub = boundedClaim(claims.sub, 512);
  if (!sub) throw authError('Authentication subject is missing');

  const permissions = Array.isArray(claims.permissions)
    ? claims.permissions.map((value) => boundedClaim(value, 160)).filter(Boolean).slice(0, 100)
    : [];
  const scopes = typeof claims.scope === 'string'
    ? claims.scope.split(/\s+/).map((value) => boundedClaim(value, 160)).filter(Boolean).slice(0, 100)
    : [];
  if (config.requiredPermission && !permissions.includes(config.requiredPermission)) {
    throw authorizationError(`Required permission is missing: ${config.requiredPermission}`);
  }

  return Object.freeze({
    sub,
    name: boundedClaim(claims.name || claims.nickname, 320),
    email: boundedClaim(claims.email, 320),
    organizationId: boundedClaim(claims.org_id, 320),
    permissions: Object.freeze([...new Set(permissions)]),
    scopes: Object.freeze([...new Set(scopes)]),
  });
}

function denyAccess(res, error) {
  const status = error?.status === 403 ? 403 : 401;
  res.status(status).set('Cache-Control', 'no-store');
  if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="AI Fleet"');
  res.json({
    error: error?.message || (status === 403 ? 'Access denied' : 'Authentication required'),
    code: error?.code || (status === 403 ? 'access_denied' : 'authentication_required'),
  });
}

function createAuthenticationMiddleware(config = CONFIG.AUTH) {
  return function authenticate(req, res, next) {
    if (!config.enabled || config.mode === 'disabled') {
      req.auth = Object.freeze({ mode: 'disabled', authenticated: false, user: null });
      next();
      return;
    }
    if (req.method === 'OPTIONS') {
      req.auth = Object.freeze({ mode: config.mode, authenticated: false, user: null });
      next();
      return;
    }

    try {
      const claims = decodeVerifiedPayload(req.get(config.payloadHeader));
      const user = identityFromClaims(claims, config);
      req.auth = Object.freeze({ mode: config.mode, authenticated: true, user });
      next();
    } catch (error) {
      denyAccess(res, error);
    }
  };
}

function publicAuthConfig(config = CONFIG.AUTH) {
  if (!config.enabled) return Object.freeze({ mode: 'disabled', enabled: false });
  return Object.freeze({
    mode: config.mode,
    enabled: true,
    provider: config.provider,
    auth0: Object.freeze({
      domain: config.domain,
      clientId: config.clientId,
      audience: config.audience,
      redirectUri: config.redirectUri,
      logoutReturnTo: config.logoutReturnTo,
      scope: config.scope,
      organization: config.organization || undefined,
    }),
  });
}

module.exports = {
  createAuthenticationMiddleware,
  decodeVerifiedPayload,
  identityFromClaims,
  publicAuthConfig,
};
