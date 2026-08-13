// Browser-free helpers for the api.js auth-retry path. Kept in a standalone
// module (no `window`/`fetch`/`/config.js` imports) so the pure logic can be
// unit-tested under `node --test` — api.js itself is not importable in Node.

/**
 * Is this response an APPLICATION-auth failure worth a token refresh + retry?
 *
 * A 401 with `authentication_required` (or any 401 on the identity probe
 * `/auth/me`) means our own Firebase session token was rejected. A connected
 * tool can also answer 401 for a missing provider key — that carries a
 * different code and must NOT lock the workspace or trigger a refresh. 403/500
 * and every 2xx are never retried.
 *
 * @param {{ status?: number, code?: string, path?: string }} [meta]
 * @returns {boolean}
 */
export function shouldRetryAuth({ status, code, path } = {}) {
  return status === 401 && (code === 'authentication_required' || path === '/auth/me');
}

/**
 * Whether a failed request should transition the browser from authenticated to
 * public mode. The response shape alone is not enough: public callers receive
 * the same `authentication_required` code when they reach a private endpoint.
 * Only a request made while an application token provider exists owns the
 * global auth-loss event.
 *
 * @param {{ status?: number, code?: string, path?: string, hasAccessTokenProvider?: boolean }} [meta]
 * @returns {boolean}
 */
export function shouldNotifyAuthenticationRequired({ hasAccessTokenProvider, ...meta } = {}) {
  return Boolean(hasAccessTokenProvider) && shouldRetryAuth(meta);
}

/**
 * Coalesce a concurrent burst of calls onto a SINGLE invocation of `fn`.
 *
 * The 12-call parallel batch a view fires on mount each hit their 401 at nearly
 * the same time; without this, each would force its own token refresh. The
 * first caller starts the flight, every caller in the burst awaits the same
 * promise, and the slot clears once it settles so a later burst refreshes anew
 * (mirroring Firebase's own short-lived token cache — not a permanent cache).
 *
 * @returns {(fn: () => Promise<any>) => Promise<any>}
 */
export function createSingleFlight() {
  let inFlight = null;
  return function run(fn) {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(() => fn())
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
