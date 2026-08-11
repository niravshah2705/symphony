'use strict';

/**
 * Express must know the number of trusted hops before req.ip is used for the
 * advisory locale lookup. AI Fleet's direct Cloud Run topology has exactly one
 * proxy hop. An explicit override is useful for local ingress tests; invalid or
 * zero values deliberately disable proxy trust.
 */
function trustProxyHops(env = process.env) {
  const explicit = String(env.TRUST_PROXY_HOPS || '').trim();
  if (explicit) {
    const hops = Number(explicit);
    return Number.isSafeInteger(hops) && hops > 0 && hops <= 8 ? hops : 0;
  }
  return env.K_SERVICE ? 1 : 0;
}

function configureTrustProxy(app, env = process.env) {
  const hops = trustProxyHops(env);
  if (hops > 0) app.set('trust proxy', hops);
  return hops;
}

module.exports = { trustProxyHops, configureTrustProxy };
