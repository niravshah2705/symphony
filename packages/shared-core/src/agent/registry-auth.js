'use strict';

/**
 * Image-registry credential material, shared by every agent pattern.
 *
 * Lifted out of the retired OpenShell client so the Substrate runner does not
 * depend on a sandbox product it outlived (the same extraction `grpc-wire.js`
 * already went through). Pure string/JSON work — no gRPC, no cluster, no store.
 */

/** `https://ghcr.io/foo/` and `ghcr.io` both normalize to `ghcr.io`. */
function normalizeRegistryHost(registryUrl) {
  const raw = String(registryUrl || 'ghcr.io').trim();
  if (!raw) return 'ghcr.io';
  return raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/**
 * A `.dockerconfigjson` payload for one registry host, or '' when the org has
 * not supplied both halves. Callers base64 it into a Secret's `data`.
 */
function buildDockerConfigJson({ registryUrl, username, password } = {}) {
  if (!username || !password) return '';
  const host = normalizeRegistryHost(registryUrl);
  const auth = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  return JSON.stringify({
    auths: {
      [host]: {
        username: String(username),
        password: String(password),
        auth,
      },
    },
  });
}

module.exports = {
  normalizeRegistryHost,
  buildDockerConfigJson,
};
