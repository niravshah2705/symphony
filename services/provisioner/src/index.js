'use strict';

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared/config');
const log = require('@ai-fleet/shared/logger');
const { decodePushMessage } = require('@ai-fleet/shared/messaging/publisher');
const { pushAuth } = require('@ai-fleet/shared/messaging/oidc');
const { provisionTenant, teardownTenant } = require('@ai-fleet/shared/provisioning');
const { handleMessage } = require('./handler');

/**
 * Provisioner service — INTERNAL, IAM-gated. It consumes tenant-provision
 * requests (published by the org service when an org is explicitly created) and
 * stands up / tears down a dedicated per-tenant Cloud Run stack, then writes the
 * resolved URLs back to the org service.
 *
 * It holds a highly privileged service account (run.admin, pubsub.admin,
 * cloudscheduler.admin, serviceAccountUser) — which is WHY it is a separate,
 * internal-only service and never the public gateway. Everything here is gated
 * by PROVISIONING_ENABLED; when off, requests are acked as a no-op.
 */

const PORT = Number(process.env.PORT) || 8080;
const PROVISIONING_ENABLED = String(process.env.PROVISIONING_ENABLED || '').trim().toLowerCase() === 'true';
const INTERNAL_API_TOKEN = String(process.env.INTERNAL_API_TOKEN || '').trim();

// Provisioning config assembled from env (mirrors deploy/gcp/terraform).
function buildCfg(projectNumber) {
  return {
    projectId: CONFIG.GCP.projectId,
    projectNumber,
    region: CONFIG.GCP.region,
    sharedOrgUrl: CONFIG.SERVICES.orgUrl,
    sharedSettingsUrl: CONFIG.SERVICES.settingsUrl,
    spaOrigin: (CONFIG.GCP.spaOrigins && CONFIG.GCP.spaOrigins[0]) || '',
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID || CONFIG.GCP.projectId,
    firebaseApiKey: process.env.FIREBASE_API_KEY || '',
    deadLetterTopic: process.env.PUBSUB_DEADLETTER_TOPIC || 'agent-requests-deadletter',
    serviceAccounts: {
      gateway: process.env.GATEWAY_SA || '',
      planner: process.env.PLANNER_SA || '',
      coder: process.env.CODER_SA || '',
      pubsubPush: process.env.PUBSUB_PUSH_SA || '',
    },
    sourceServiceNames: {
      gateway: process.env.GATEWAY_SERVICE_NAME || 'gateway',
      planner: process.env.PLANNER_SERVICE_NAME || 'planner',
      coder: process.env.CODER_SERVICE_NAME || 'coder-control',
      worker: process.env.CODER_JOB_NAME || 'coder-worker',
    },
  };
}

// Cloud Run's deterministic URL scheme needs the numeric project id.
async function resolveProjectNumber() {
  if (process.env.PROJECT_NUMBER) return String(process.env.PROJECT_NUMBER).trim();
  try {
    const res = await fetch('http://metadata.google.internal/computeMetadata/v1/project/numeric-project-id', {
      headers: { 'Metadata-Flavor': 'Google' },
    });
    return (await res.text()).trim();
  } catch (_) {
    return '';
  }
}

// S2S OIDC header (audience = org origin) for the IAM-gated org service.
let googleAuth = null;
async function s2sAuthHeader(audience) {
  if (CONFIG.MESSAGING_MODE !== 'pubsub') return '';
  if (!googleAuth) {
    const { GoogleAuth } = require('google-auth-library');
    googleAuth = new GoogleAuth();
  }
  const client = await googleAuth.getIdTokenClient(audience);
  const headers = await client.getRequestHeaders();
  // google-auth-library v10+ returns a WHATWG Headers object here; v9 returned a
  // plain object. Read via .get() when available so the S2S OIDC token survives.
  if (typeof headers.get === 'function') return headers.get('authorization') || '';
  return headers.Authorization || headers.authorization || '';
}

async function writeBack(orgId, deployments) {
  const base = CONFIG.SERVICES.orgUrl;
  if (!base) throw new Error('ORG_URL unset — cannot write back deployments');
  const origin = (() => { try { return new URL(base).origin; } catch (_) { return base; } })();
  const headers = { 'content-type': 'application/json', 'x-internal-token': INTERNAL_API_TOKEN };
  const auth = await s2sAuthHeader(origin);
  if (auth) headers.authorization = auth;
  const res = await fetch(`${base}/api/v1/internal/orgs/${orgId}/deployments`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ deployments }),
  });
  if (!res.ok) throw new Error(`deployment write-back failed (${res.status})`);
}

function createApp(cfg) {
  const app = express();
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
  app.use(express.json({ limit: '1mb' }));
  app.get('/healthz', (req, res) => res.json({ status: 'ok', provisioningEnabled: PROVISIONING_ENABLED }));

  // Pub/Sub push: provision/teardown a tenant. OIDC-verified (pushAuth).
  app.post('/pubsub/tenant-provision', pushAuth(), (req, res) => {
    const message = decodePushMessage(req.body);
    if (!PROVISIONING_ENABLED) {
      log.info('provisioner: PROVISIONING_ENABLED is off — acking request as no-op.');
      return res.status(204).end(); // ack; do nothing
    }
    // Long-running (minutes): ack immediately, work in the background. Retries on
    // failure come from Pub/Sub redelivery; status=failed is written meanwhile.
    Promise.resolve(handleMessage(message, { provisionTenant, teardownTenant, writeBack, cfg, log }))
      .catch((err) => log.error(`provisioner dispatch error: ${err && err.message ? err.message : err}`));
    return res.status(204).end();
  });

  return app;
}

async function start() {
  const projectNumber = await resolveProjectNumber();
  const cfg = buildCfg(projectNumber);
  if (PROVISIONING_ENABLED && !INTERNAL_API_TOKEN) {
    log.error('provisioner: PROVISIONING_ENABLED but INTERNAL_API_TOKEN unset — write-back will be refused.');
  }
  const app = createApp(cfg);
  app.listen(PORT, () => log.info(`provisioner listening on :${PORT} (enabled=${PROVISIONING_ENABLED})`));
}

if (require.main === module) {
  start().catch((err) => { log.error(`provisioner failed to start: ${err && err.message ? err.message : err}`); process.exit(1); });
}

module.exports = { createApp, buildCfg, writeBack };
