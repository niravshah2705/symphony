'use strict';

const express = require('express');
const path = require('path');
const { CONFIG } = require('@ai-fleet/shared/config');
const { sendError } = require('@ai-fleet/shared/util');
const log = require('@ai-fleet/shared/logger');

const settingsRoutes = require('./routes/settings');
const projectsRoutes = require('./routes/projects');
const issuesRoutes = require('./routes/issues');
const businessesRoutes = require('./routes/businesses');
const rolesRoutes = require('./routes/roles');
const observabilityRoutes = require('./routes/observability');
const localizationRoutes = require('./routes/localization');
const { router: codexRoutes, callback: codexCallback } = require('./routes/codex');
const { router: claudeRoutes } = require('./routes/claude');
const { createProxy } = require('./proxy');
const { createAuthenticationMiddleware, publicAuthConfig } = require('./auth');
const { createCorsMiddleware } = require('./cors');
const { initStore, getConversation } = require('@ai-fleet/shared/store');
const events = require('@ai-fleet/shared/messaging/events');
const publish = require('./publish');
const sse = require('./sse');
const { mintStreamToken } = require('./stream-token');

/**
 * Gateway service — the single browser-facing origin. It serves the SPA, owns
 * the user-facing REST API (settings, projects, issues, businesses, roles) and
 * the OAuth flows (Codex/Claude), and reverse-proxies the two agent surfaces to
 * their isolated services:
 *   /api/agent/*  → planner service (CONFIG.SERVICES.plannerUrl)
 *   /api/coder/*  → coder service   (CONFIG.SERVICES.coderUrl)
 * The frontend keeps calling same-origin /api/* paths and is unaware of the
 * split.
 */
const app = express();

// True in the cloud (Pub/Sub) profile: the SPA is hosted on GCS and the gateway
// is API-only, so it does not serve static files or trust localhost same-origin.
const IS_CLOUD = CONFIG.MESSAGING_MODE === 'pubsub';

// Security response headers (infra/ingress checklists). HSTS only over the public
// HTTPS deployment; nosniff + referrer policy always.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  if (IS_CLOUD) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// CORS for the cross-origin GCS SPA (no-op when no SPA origins are configured).
app.use(createCorsMiddleware());

app.use(express.json({ limit: '1mb' }));

// Public liveness and browser bootstrap. The SPA must learn its non-secret
// Firebase web config (apiKey/authDomain/projectId) before it can sign in.
// No other API route is mounted ahead of the authentication boundary.
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.get('/api/auth/config', (req, res) => {
  res.set('Cache-Control', 'no-store').json(publicAuthConfig());
});

// Local multi-process event collector: worker services POST their conversation
// events here and the gateway injects them into its in-process bus for SSE.
// Disabled in the cloud (EVENTS_BACKEND=firestore fans out via onSnapshot).
app.post('/internal/events', (req, res) => {
  if (CONFIG.EVENTS_BACKEND === 'firestore') return res.status(404).end();
  const { conversationId, event } = req.body || {};
  events.ingest(conversationId, event);
  return res.status(204).end();
});

// The Firebase Web SDK is a static asset under public/vendor/firebase/ (served
// by express.static locally and from GCS in the cloud) — no gateway route needed.

// SSE stream — mounted BEFORE the bearer auth middleware because EventSource
// cannot send an Authorization header; it authorizes via a signed stream token
// in the query string instead (see sse.js / stream-token.js).
app.get('/api/agent/stream', sse.handleStream);

// In local development this middleware is a no-op. AUTH_MODE=firebase fails
// closed unless a valid Firebase ID token accompanies every API call.
app.use('/api', createAuthenticationMiddleware());
app.get('/api/auth/me', (req, res) => {
  res.set('Cache-Control', 'no-store').json(req.auth);
});

// Mint a short-lived stream token for the authenticated user to open an SSE
// connection for a specific conversation. AI Fleet is single-tenant by design —
// all fleet:access operators share one store/conversations (see README), so there
// is no per-user ownership boundary to enforce here. We still require the
// conversation to EXIST so tokens can't be minted for arbitrary/guessed ids.
app.get('/api/agent/stream-token', (req, res) => {
  const conversationId = String(req.query.conversationId || '').trim();
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required.' });
  if (!getConversation(conversationId)) return res.status(404).json({ error: 'Unknown conversation.' });
  return res.set('Cache-Control', 'no-store').json({ token: mintStreamToken(conversationId), conversationId });
});

// User-facing API routes (owned by the gateway).
app.use('/api/settings', settingsRoutes);
app.use('/api/settings/codex', codexRoutes);
app.use('/api/settings/claude', claudeRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/issues', issuesRoutes);
app.use('/api/businesses', businessesRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/observability', observabilityRoutes);
app.use('/api/locale', localizationRoutes);

// The two long-running request submissions are PUBLISHED (Pub/Sub) rather than
// proxied — they return a conversationId the browser streams via SSE. Registered
// before the proxies so these exact paths win.
app.post('/api/agent/enqueue', publish.enqueue);
app.post('/api/coder/run', publish.coderRun);

// All other agent surfaces are reverse-proxied to their isolated services.
app.use('/api/agent', createProxy(CONFIG.SERVICES.plannerUrl));
app.use('/api/coder', createProxy(CONFIG.SERVICES.coderUrl));

// Codex OAuth redirect target — must be registered before the SPA fallback.
app.get('/auth/callback', codexCallback);

// Static frontend — served by the gateway only in local dev. In the cloud the
// SPA is hosted on GCS and the gateway is API-only.
if (!IS_CLOUD) {
  app.use(express.static(CONFIG.PUBLIC_DIR));
  // SPA fallback for any non-API GET request.
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(CONFIG.PUBLIC_DIR, 'index.html'));
  });
}

// Central JSON error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  sendError(res, err);
});

initStore()
  .then(() => {
    app.listen(CONFIG.SERVICES.gatewayPort, () => {
      log.info(`AI Fleet gateway running at http://localhost:${CONFIG.SERVICES.gatewayPort}`);
      log.info(`  → proxying /api/agent to ${CONFIG.SERVICES.plannerUrl}`);
      log.info(`  → proxying /api/coder to ${CONFIG.SERVICES.coderUrl}`);
    });
  })
  .catch((err) => {
    log.error(`gateway failed to initialize store: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });

module.exports = app;
