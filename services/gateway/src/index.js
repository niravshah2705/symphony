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

app.use(express.json({ limit: '1mb' }));

// Public liveness and browser bootstrap. Auth0's SPA client must learn its
// non-secret tenant/client/audience settings before it can obtain an access
// token. No other API route is mounted ahead of the authentication boundary.
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.get('/api/auth/config', (req, res) => {
  res.set('Cache-Control', 'no-store').json(publicAuthConfig());
});

// Serve the pinned Auth0 SDK from this origin rather than executing a mutable
// third-party CDN script in the authenticated application.
const auth0SdkPath = path.join(
  path.dirname(require.resolve('@auth0/auth0-spa-js/package.json')),
  'dist',
  'auth0-spa-js.production.esm.js'
);
app.get('/vendor/auth0-spa-js.js', (req, res) => res.sendFile(auth0SdkPath));

// In local development this middleware is a no-op. AUTH_MODE=istio fails
// closed unless Envoy supplied a verified Auth0 payload for every API call.
app.use('/api', createAuthenticationMiddleware());
app.get('/api/auth/me', (req, res) => {
  res.set('Cache-Control', 'no-store').json(req.auth);
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

// Agent surfaces are proxied to their isolated services.
app.use('/api/agent', createProxy(CONFIG.SERVICES.plannerUrl));
app.use('/api/coder', createProxy(CONFIG.SERVICES.coderUrl));

// Codex OAuth redirect target — must be registered before the SPA fallback.
app.get('/auth/callback', codexCallback);

// Static frontend.
app.use(express.static(CONFIG.PUBLIC_DIR));

// SPA fallback for any non-API GET request.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(CONFIG.PUBLIC_DIR, 'index.html'));
});

// Central JSON error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  sendError(res, err);
});

app.listen(CONFIG.SERVICES.gatewayPort, () => {
  log.info(`AI Fleet gateway running at http://localhost:${CONFIG.SERVICES.gatewayPort}`);
  log.info(`  → proxying /api/agent to ${CONFIG.SERVICES.plannerUrl}`);
  log.info(`  → proxying /api/coder to ${CONFIG.SERVICES.coderUrl}`);
});

module.exports = app;
