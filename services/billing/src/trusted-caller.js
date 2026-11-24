'use strict';

/**
 * Which organization a billing request is allowed to address.
 *
 * The gateway resolves the caller's org SERVER-SIDE (from the org service, against
 * the caller's verified bearer) and forwards it as `x-ai-fleet-billing-*` headers.
 * Those headers are the only way one tenant's data is selected, so the question
 * this file answers is the one the network used to answer by implication: *is this
 * request actually from the gateway?*
 *
 * Until now the answer was "assume yes" — the billing service verified nothing, so
 * any peer that could open a socket (the local `npm start` topology, a VPC peer, a
 * mis-widened Cloud Run IAM binding, an operator port-forward) could read any
 * org's credits, packs, usage and ledger simply by naming its org id. Here that
 * becomes a property of the endpoint: the trusted headers are honored only behind
 * a proof, and everything else addresses this deployment's own org.
 *
 * Three proofs, in order:
 *   1. `x-internal-token` equals `INTERNAL_API_TOKEN` — the direct/S2S mode the
 *      gateway proxy already sends (`services/gateway/src/proxy.js:58-63`).
 *   2. A Google OIDC ID token whose audience is this service and whose signer is
 *      in `BILLING_TRUSTED_SERVICE_ACCOUNTS` — what Cloud Run IAM puts on a proxied
 *      request when the deployment runs in pubsub mode.
 *   3. The local development profile (`AUTH_MODE=disabled`, which
 *      `config.js:194` refuses in production) reached over loopback. A dev box has
 *      one operator and no other identity; a socket from anywhere else is not it.
 *
 * With none of the three the request is NOT rejected — it is scoped. It gets
 * `CONFIG.BILLING.orgId` (the deployment's own org, `__shared__` when it has
 * none), `isAdmin: false`, and `trusted: false`, which the Usage reads turn into
 * a degraded envelope with zero FlexPrice calls and the money mutations turn into
 * a 403. Failing closed has to be observable, so the reason rides along.
 */

const crypto = require('node:crypto');
const { CONFIG } = require('@software-factory/shared-core/config');
const log = require('@software-factory/shared-core/logger');
const { SHARED_ORG_ID } = require('@software-factory/shared-core/billing/org-context');
const { verifyPushToken } = require('@software-factory/shared-core/messaging/oidc');

const BILLING_ORG_HEADER = 'x-ai-fleet-billing-org-id';
const BILLING_ROLE_HEADER = 'x-ai-fleet-billing-org-role';
const BILLING_USER_HEADER = 'x-ai-fleet-billing-user-id';
const INTERNAL_TOKEN_HEADER = 'x-internal-token';
const ORG_ADMIN_ROLE = 'ORG_ADMIN';

/**
 * An org id is a cache-key segment here and a URL path segment downstream in the
 * FlexPrice client. `|` is the cache separator and `/`/`?`/`%` rewrite a route, so
 * an id containing any of them lets one tenant address another — which is why the
 * shape is checked rather than assumed, even though real ids are UUIDs.
 */
const ORG_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;

const LOOPBACK_V4 = /^127\./;
const LOOPBACK_V6 = /^::1$/;
const V4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

function deploymentOrgId(config = CONFIG.BILLING) {
  return String((config && config.orgId) || '').trim() || SHARED_ORG_ID;
}

/**
 * The peer that opened the socket, from the connection only.
 *
 * `X-Forwarded-For` is deliberately unread: the gateway sets it, so trusting it
 * here would let any caller claim to be loopback — the exact spoof this middleware
 * exists to close.
 */
function isLoopbackPeer(req) {
  const address = String((req && req.socket && req.socket.remoteAddress)
    || (req && req.connection && req.connection.remoteAddress) || '');
  if (!address) return false;
  const mapped = V4_MAPPED.exec(address);
  const host = mapped ? mapped[1] : address;
  return LOOPBACK_V4.test(host) || LOOPBACK_V6.test(host);
}

function tokensMatch(supplied, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(String(expected));
  // Same length first, then a constant-time compare: a short-circuit on prefix
  // equality is what turns a secret into a brute-forceable one.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeEmails(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

/** The caller the trusted headers describe, with the org id shape-checked. */
function callerFromHeaders(req, { orgId, trusted, proof }) {
  const named = String(req.get(BILLING_ORG_HEADER) || '').trim();
  if (named && !ORG_ID_RE.test(named)) {
    // A gateway that names a malformed org is broken or hostile; either way it
    // selects nothing. Pin rather than pass the value downstream.
    return {
      orgId: orgId || deploymentOrgId(),
      userId: null,
      isAdmin: false,
      trusted: false,
      proof: null,
      unverified: 'invalid_org_header',
    };
  }
  const userId = String(req.get(BILLING_USER_HEADER) || '').trim() || null;
  const isAdmin = String(req.get(BILLING_ROLE_HEADER) || '').trim().toUpperCase() === ORG_ADMIN_ROLE;
  return {
    orgId: named || orgId || deploymentOrgId(),
    userId,
    isAdmin,
    trusted,
    proof,
    unverified: null,
  };
}

/** The caller of a request that proved nothing: this deployment, and nothing else. */
function untrustedCaller(req, { unverified = 'no_caller_proof', orgId = null } = {}) {
  return {
    orgId: orgId || deploymentOrgId(),
    userId: null,
    isAdmin: false,
    trusted: false,
    proof: null,
    unverified,
    // Whether the client tried to name an org anyway — the difference between an
    // unauthenticated probe and someone pointed at the wrong tenant.
    ignoredHeaders: Boolean(String((req && req.get && req.get(BILLING_ORG_HEADER)) || '').trim()),
  };
}

function proofOptions(options = {}) {
  const env = options.env || process.env;
  const config = options.config || CONFIG;
  return {
    config,
    internalToken: String(options.internalToken ?? env.INTERNAL_API_TOKEN ?? '').trim(),
    audience: String(options.audience ?? config.BILLING.trustedCallerAudience ?? '').trim(),
    trustedEmails: normalizeEmails(options.trustedEmails ?? config.BILLING.trustedServiceAccounts),
    authMode: String(options.authMode ?? config.AUTH.mode ?? 'disabled'),
    // The OIDC proof is only attempted when it can actually be checked: an unset
    // audience means `verifyIdToken` would accept a token minted for anything.
    allowOidc: options.allowOidc !== false,
    verifyToken: options.verifyToken || verifyPushToken,
  };
}

/**
 * Resolve the caller of a request. Async because proof 2 verifies a token, which
 * hits Google's keys; the returned object is the only place an org is selected for
 * a billing read or write.
 */
async function resolveTrustedCaller(req, options = {}) {
  const o = proofOptions(options);
  const orgId = deploymentOrgId(o.config.BILLING);

  if (o.internalToken && tokensMatch(req.get(INTERNAL_TOKEN_HEADER), o.internalToken)) {
    return callerFromHeaders(req, { orgId, trusted: true, proof: 'internal-token' });
  }

  const hasBearer = /^Bearer\s/i.test(String(req.get('authorization') || '').trim());
  if (o.allowOidc && o.audience && o.trustedEmails.length && hasBearer) {
    try {
      const payload = await o.verifyToken(req, { audience: o.audience, allowedEmails: o.trustedEmails });
      const email = String((payload && payload.email) || '').toLowerCase();
      if (o.trustedEmails.includes(email)) {
        return callerFromHeaders(req, { orgId, trusted: true, proof: 'gateway-id-token' });
      }
      return pinUntrusted(req, 'id_token_signer_not_trusted', orgId);
    } catch (err) {
      return pinUntrusted(req, `id_token_rejected:${err && err.message ? err.message.slice(0, 80) : 'error'}`, orgId);
    }
  }

  if (o.authMode === 'disabled' && isLoopbackPeer(req)) {
    return callerFromHeaders(req, { orgId, trusted: true, proof: 'local-loopback' });
  }

  return pinUntrusted(req, 'no_caller_proof', orgId);
}

/**
 * Scope the request to this deployment and say why, but only when it tried to name
 * an org: the probes and the standalone dashboard hit these routes with no billing
 * headers at all, on every page render, and logging those would bury the attempt.
 */
function pinUntrusted(req, unverified, orgId = null) {
  const caller = untrustedCaller(req, { unverified, orgId });
  if (caller.ignoredHeaders) log.warn('billing_caller_unverified', { unverified, peer: redactPeer(req) });
  return caller;
}

function redactPeer(req) {
  const address = String((req && req.socket && req.socket.remoteAddress) || '');
  return address ? address.replace(/\d+$/, 'x') : null;
}

/** Express middleware: attach `req.billingCaller`. Never rejects — it scopes. */
function createTrustedCallerMiddleware(options = {}) {
  const resolve = options.resolveCaller || resolveTrustedCaller;
  return async function requireTrustedCaller(req, res, next) {
    try {
      req.billingCaller = await resolve(req, options);
    } catch (err) {
      // A proof that cannot be evaluated is a proof that failed. Answering with
      // the headers anyway would make the failure mode a leak.
      log.error(`billing_caller_resolution_failed: ${err && err.message ? err.message : err}`);
      req.billingCaller = untrustedCaller(req, {
        unverified: 'resolution_failed',
        orgId: deploymentOrgId((options.config || CONFIG).BILLING),
      });
    }
    next();
  };
}

/**
 * The caller of a request, for a route body.
 *
 * `req.billingCaller` — written by the middleware, the only place a proof is
 * evaluated — is the only trusted input. A router reached without that middleware
 * gets this deployment's own org rather than re-deriving one from headers: a second
 * copy of the trust decision would be a second thing to forget, and forgetting it
 * is the leak this file exists to close.
 */
function callerOf(req, options = {}) {
  if (req && req.billingCaller) return req.billingCaller;
  return untrustedCaller(req || {}, {
    unverified: 'middleware_not_applied',
    orgId: deploymentOrgId((options.config || CONFIG).BILLING),
  });
}

/**
 * Say once, at boot, what this deployment will accept as proof.
 *
 * A warning, never a throw: with no proof path configured the endpoint still
 * answers only its own org, and killing the process would take the payment
 * webhooks down with it — a fail-closed config error must not become an outage.
 */
function reportBoot(options = {}) {
  const o = proofOptions(options);
  const gaps = [];
  if (!o.internalToken) gaps.push('INTERNAL_API_TOKEN unset, so direct-mode callers cannot prove themselves');
  if (!o.audience || !o.trustedEmails.length) {
    gaps.push('BILLING_TRUSTED_CALLER_AUDIENCE / BILLING_TRUSTED_SERVICE_ACCOUNTS unset, so proxied ID-token callers cannot prove themselves');
  }
  if (o.authMode === 'disabled') gaps.push('AUTH_MODE=disabled, so loopback callers are trusted without a credential (development only)');
  if (gaps.length) {
    log.warn('billing_caller_trust_unconfigured', { gaps, effect: 'unproven requests address this deployment org only' });
  }
  return gaps;
}

module.exports = {
  BILLING_ORG_HEADER,
  BILLING_ROLE_HEADER,
  BILLING_USER_HEADER,
  INTERNAL_TOKEN_HEADER,
  ORG_ADMIN_ROLE,
  ORG_ID_RE,
  createTrustedCallerMiddleware,
  resolveTrustedCaller,
  callerOf,
  untrustedCaller,
  deploymentOrgId,
  isLoopbackPeer,
  tokensMatch,
  reportBoot,
};
