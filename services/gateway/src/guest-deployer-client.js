'use strict';

/**
 * Guest preview broker client.
 *
 * The gateway is browser-facing, so it must not hold the hosting credential —
 * `services/guest-deployer` is the only workload that can write the guest site,
 * and this client is the only way the gateway reaches it. Two consequences shape
 * the code:
 *
 *  - The credential is the broker's own shared secret
 *    (`GUEST_DEPLOYER_INTERNAL_TOKEN` on this side, `GUEST_DEPLOY_INTERNAL_TOKEN`
 *    on its side), never `INTERNAL_API_TOKEN`. The platform-wide S2S token would
 *    open the org and settings services with it, which is exactly the fifth
 *    place for a key this service exists to avoid. In cloud mode Cloud Run also
 *    mints an OIDC ID token for IAM, and the broker accepts either.
 *  - A preview is a convenience, not a promise. If the broker is unreachable or
 *    refuses, the demo has still produced a plan, a component map and a real
 *    four-CR set, so this returns `null` and logs why rather than failing the
 *    visitor's turn. The runner renders the `live-url` step as skipped.
 */

const { CONFIG } = require('@software-factory/shared-core/config');
const log = require('@software-factory/shared-core/logger');
const { callJson } = require('./service-client');

const RPC_PATH = '/internal/s2s/guest-deploy';

function createGuestDeployerClient(options = {}) {
  const baseUrl = options.baseUrl !== undefined ? options.baseUrl : CONFIG.GUEST_DEMO.deployerUrl;
  const token = options.token !== undefined ? options.token : CONFIG.GUEST_DEMO.deployerToken;
  if (!baseUrl) throw new TypeError('createGuestDeployerClient requires a broker URL');

  function headers() {
    // Set explicitly so the shared secret travels in both messaging modes; in
    // pubsub mode `callJson` mints an OIDC token for Cloud Run IAM and touches
    // no internal-token header, so this is the only place it can come from.
    return token ? { 'x-internal-token': String(token) } : {};
  }

  // `internalToken` is passed alongside the header because `callJson` resolves
  // the header itself in direct mode and would otherwise fall back to the
  // platform-wide INTERNAL_API_TOKEN — a different key, which the broker refuses.
  function auth(opts) {
    return { ...opts, headers: headers(), internalToken: token };
  }

  function unusable(what, detail) {
    log.error(`guest-deployer ${what} failed${detail ? `: ${detail}` : ''}`);
    return null;
  }

  /** Publish a template and return the broker's handle, or null if it could not. */
  async function deploy({ template, variant = {} } = {}) {
    if (!template) return unusable('deploy', 'no template was selected');
    let result;
    try {
      result = await callJson(baseUrl, RPC_PATH, auth({ method: 'POST', body: { template, variant } }));
    } catch (error) {
      return unusable('deploy', error && error.message ? error.message : String(error));
    }
    const data = result && result.data;
    if (!result || result.status < 200 || result.status >= 300 || !data || typeof data.token !== 'string') {
      return unusable('deploy', `HTTP ${result ? result.status : 0}`);
    }
    return { token: data.token, url: typeof data.url === 'string' ? data.url : null, expiresAt: data.expiresAt || null };
  }

  /** Re-release a variant under the same handle. Returns false when nothing changed. */
  async function redeploy({ token: previewToken, template = null, variant = {} } = {}) {
    if (!previewToken) {
      unusable('redeploy', 'no preview handle');
      return false;
    }
    let result;
    try {
      result = await callJson(baseUrl, `${RPC_PATH}/${encodeURIComponent(previewToken)}`, auth({ method: 'POST', body: { template, variant } }));
    } catch (error) {
      unusable('redeploy', error && error.message ? error.message : String(error));
      return false;
    }
    if (!result || result.status < 200 || result.status >= 300) {
      unusable('redeploy', `HTTP ${result ? result.status : 0}`);
      return false;
    }
    return true;
  }

  /** Withdraw a preview before its expiry. */
  async function remove(previewToken) {
    if (!previewToken) return false;
    let result;
    try {
      result = await callJson(baseUrl, `${RPC_PATH}/${encodeURIComponent(previewToken)}`, auth({ method: 'DELETE' }));
      return Boolean(result && result.status >= 200 && result.status < 300);
    } catch (error) {
      unusable('remove', error && error.message ? error.message : String(error));
      return false;
    }
  }

  return { deploy, redeploy, remove, RPC_PATH };
}

module.exports = { createGuestDeployerClient, RPC_PATH };
