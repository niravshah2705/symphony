'use strict';

const path = require('node:path');
const { CONFIG } = require('@software-factory/shared-core/config');

/**
 * Environment for the guest preview broker.
 *
 * This process is deliberately outside the application's `CONFIG` wiring except
 * for the two values it must agree with the gateway on — the preview retention
 * and the data directory — because a disagreement there would mean the session
 * says one expiry and the hosting release keeps another. Everything else is
 * read straight from `process.env` so the service stays auditable as a single
 * small surface: one secret, one project, one site.
 *
 * It fails closed. Without its internal token it cannot tell a caller from a
 * stranger; without a project it would publish to whatever default the
 * credential happened to have.
 */

const DEFAULT_BIND_HOST = '127.0.0.1';
const CLOUD_RUN_BIND_HOST = '0.0.0.0';
const DEFAULT_PORT = 8080;
const DEFAULT_SITE = 'guest-previews';
const DEFAULT_CHANNEL = 'live';
const MIN_TOKEN_CHARS = 16;
const MAX_BODY_BYTES = 64 * 1024;

// A Firebase project id and a hosting site id are both lowercase DNS-ish names.
// Validating them keeps an operator typo out of a resource name we then put in
// every preview URL.
const PROJECT_RE = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const SITE_RE = /^[a-z]([-a-z0-9]{0,62}[a-z0-9])?$/;

function required(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} is required for the guest preview broker`);
  return text;
}

function resolveBindHost(value = process.env.GUEST_DEPLOY_BIND_HOST) {
  const host = String(value || '').trim() || DEFAULT_BIND_HOST;
  if (host !== DEFAULT_BIND_HOST && host !== CLOUD_RUN_BIND_HOST) {
    throw new Error('GUEST_DEPLOY_BIND_HOST must be 127.0.0.1 or 0.0.0.0');
  }
  return host;
}

function guestDeployConfig(env = process.env) {
  const token = required(env.GUEST_DEPLOY_INTERNAL_TOKEN, 'GUEST_DEPLOY_INTERNAL_TOKEN');
  if (token.length < MIN_TOKEN_CHARS) {
    throw new Error(`GUEST_DEPLOY_INTERNAL_TOKEN must be at least ${MIN_TOKEN_CHARS} characters`);
  }
  const project = required(env.GUEST_FIREBASE_PROJECT, 'GUEST_FIREBASE_PROJECT');
  if (!PROJECT_RE.test(project)) throw new Error('GUEST_FIREBASE_PROJECT is not a valid Firebase project id');
  const site = String(env.GUEST_FIREBASE_SITE || DEFAULT_SITE).trim() || DEFAULT_SITE;
  if (!SITE_RE.test(site)) throw new Error('GUEST_FIREBASE_SITE is not a valid hosting site id');
  const channel = String(env.GUEST_HOSTING_CHANNEL || DEFAULT_CHANNEL).trim() || DEFAULT_CHANNEL;
  if (!SITE_RE.test(channel)) throw new Error('GUEST_HOSTING_CHANNEL is not a valid hosting channel id');

  const retentionMs = Number(env.GUEST_PREVIEW_TTL_MS || CONFIG.GUEST_DEMO.previewTtlMs);
  if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) {
    throw new Error('GUEST_PREVIEW_TTL_MS must be a positive number of milliseconds');
  }

  const dataDir = String(env.GUEST_DEPLOY_DATA_DIR || path.join(CONFIG.DATA_DIR, 'guest-deploy')).trim();
  if (!path.isAbsolute(dataDir)) throw new Error('GUEST_DEPLOY_DATA_DIR must be an absolute path');

  // The preview origin is informational here — the gateway stamps the URL the
  // browser is given — but deriving it from the site keeps the two from
  // drifting into different answers about where a preview lives.
  const previewBaseOrigin = String(env.GUEST_PREVIEW_BASE_URL || `https://${site}.web.app`).trim().replace(/\/+$/, '');

  return Object.freeze({
    token,
    project,
    site,
    channel,
    retentionMs,
    dataDir,
    previewBaseOrigin,
    bindHost: resolveBindHost(env.GUEST_DEPLOY_BIND_HOST),
    port: Number(env.PORT) || DEFAULT_PORT,
    maxBodyBytes: MAX_BODY_BYTES,
  });
}

module.exports = {
  guestDeployConfig,
  resolveBindHost,
  DEFAULT_BIND_HOST,
  CLOUD_RUN_BIND_HOST,
  DEFAULT_SITE,
  DEFAULT_CHANNEL,
  MAX_BODY_BYTES,
};
