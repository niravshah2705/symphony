'use strict';

const { CONFIG } = require('@ai-fleet/shared/config');

/**
 * Thin HTTP client for the AI Fleet gateway — the only intended client-facing
 * origin. Uses global fetch (Node 18+), matching the rest of the codebase
 * (no axios/node-fetch anywhere). The gateway owns auth/RBAC and reverse-proxies
 * /api/agent/* → planner and /api/coder/* → coder, so the CLI never talks to the
 * agent services directly.
 */

/** Default base URL: --api flag, then $ADLC_API_URL, then the gateway port from CONFIG. */
function resolveBaseUrl(flags = {}) {
  const fromFlag = typeof flags.api === 'string' ? flags.api : '';
  const raw = fromFlag || process.env.ADLC_API_URL || `http://localhost:${CONFIG.SERVICES.gatewayPort}`;
  return String(raw).replace(/\/+$/, '');
}

/**
 * Bearer token, ENV ONLY. Never read from a flag so it cannot leak into shell
 * history, `ps` output, or logs. Only needed when the gateway runs in firebase
 * auth mode; local AUTH_MODE=disabled needs no token.
 */
function resolveToken() {
  const token = process.env.ADLC_TOKEN;
  return token ? String(token) : null;
}

/**
 * @param {{ baseUrl?: string, token?: string|null, fetchImpl?: typeof fetch }} [options]
 */
function createClient(options = {}) {
  const base = String(options.baseUrl || `http://localhost:${CONFIG.SERVICES.gatewayPort}`).replace(/\/+$/, '');
  const token = options.token || null;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('global fetch is unavailable — Node 18+ is required.');
  }
  const authHeader = token ? { Authorization: `Bearer ${token}` } : {};

  /**
   * Perform a JSON request. Resolves to the parsed body; throws an Error whose
   * message is the server's `{ error }` (already sanitized server-side) on non-2xx.
   */
  async function request(method, path, body) {
    const headers = { Accept: 'application/json', ...authHeader };
    const init = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
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
      throw error;
    }
    return data;
  }

  return { base, token, hasToken: Boolean(token), request };
}

module.exports = { createClient, resolveBaseUrl, resolveToken };
