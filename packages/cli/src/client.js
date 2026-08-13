'use strict';

const { CONFIG } = require('@ai-fleet/shared/config');
const credentials = require('./credentials');
const { version: VERSION } = require('../package.json');

/**
 * Thin HTTP client for the AI Fleet gateway — the only intended client-facing
 * origin. Uses global fetch (Node 22+), matching the supported runtime for
 * this workspace
 * (no axios/node-fetch anywhere). The gateway owns auth/RBAC and reverse-proxies
 * /api/agent/* → planner and /api/coder/* → coder, so the CLI never talks to the
 * agent services directly.
 *
 * Every request carries the CLI version (User-Agent + X-Adlc-Version) and, when
 * available, the bearer token (see resolveToken).
 */

/** Default base URL: --api flag → $ADLC_API_URL → stored login → gateway port from CONFIG. */
function resolveBaseUrl(flags = {}) {
  const fromFlag = typeof flags.api === 'string' ? flags.api : '';
  const stored = credentials.load();
  const storedUrl = stored && typeof stored.apiUrl === 'string' ? stored.apiUrl : '';
  const raw = fromFlag || process.env.ADLC_API_URL || storedUrl || `http://localhost:${CONFIG.SERVICES.gatewayPort}`;
  return String(raw).replace(/\/+$/, '');
}

/**
 * Bearer token: $ADLC_TOKEN (explicit override, e.g. CI) → the token saved by
 * `adlc auth login` (~/.adlc/credentials.json). Never read from a flag, so it
 * can't leak into shell history, `ps`, or logs. Only needed when the gateway
 * runs in firebase auth mode; local AUTH_MODE=disabled needs no token.
 */
function resolveToken() {
  if (process.env.ADLC_TOKEN) return String(process.env.ADLC_TOKEN);
  return credentials.storedToken();
}

/**
 * @param {{ baseUrl?: string, token?: string|null, fetchImpl?: typeof fetch }} [options]
 */
function createClient(options = {}) {
  const base = String(options.baseUrl || `http://localhost:${CONFIG.SERVICES.gatewayPort}`).replace(/\/+$/, '');
  const token = options.token || null;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('global fetch is unavailable — Node 22+ is required.');
  }

  /** Default headers for every request: version identifiers + optional bearer. */
  function headers(extra = {}) {
    const defaults = { 'User-Agent': `adlc/${VERSION}`, 'X-Adlc-Version': VERSION };
    if (token) defaults.Authorization = `Bearer ${token}`;
    return { ...defaults, ...extra };
  }

  /**
   * Perform a JSON request. Resolves to the parsed body; throws an Error whose
   * message is the server's `{ error }` (already sanitized server-side) on non-2xx.
   */
  async function request(method, path, body, options = {}) {
    const extraHeaders = options && options.headers && typeof options.headers === 'object'
      ? options.headers
      : {};
    const h = headers({ Accept: 'application/json' });
    // Scope is the only supported per-request header customization. Keep auth
    // and version headers owned by the client so a call site cannot replace
    // those trust signals accidentally.
    for (const name of ['x-ai-fleet-organization-id', 'x-ai-fleet-project-id']) {
      const value = extraHeaders[name];
      if (typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value)) h[name] = value;
    }
    const init = { method, headers: h };
    if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetchImpl(`${base}${path}`, init);
    } catch (err) {
      throw new Error(`Cannot reach the gateway at ${base} — is the fleet running (npm start)? (${err && err.message ? err.message : err})`);
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = { raw: text };
      }
    }

    if (!res.ok) {
      const message = (data && (data.error || data.message)) || `HTTP ${res.status} ${res.statusText || ''}`.trim();
      const error = new Error(message);
      error.status = res.status;
      error.body = data;
      if (res.status === 401) {
        error.hint = 'Missing or expired token — run `adlc auth login` (or set $ADLC_TOKEN).';
      }
      throw error;
    }
    return data;
  }

  return { base, token, version: VERSION, hasToken: Boolean(token), headers, request };
}

module.exports = { createClient, resolveBaseUrl, resolveToken };
