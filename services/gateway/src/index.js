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
const billingRoutes = require('./routes/billing');
const localizationRoutes = require('./routes/localization');
const eulaRoutes = require('./routes/eula');
const { router: codexRoutes, callback: codexCallback } = require('./routes/codex');
const { router: claudeRoutes } = require('./routes/claude');
const { createProxy } = require('./proxy');
const { blockInternalProxy } = require('./settings-internal-guard');
const { createAuthenticationMiddleware, requirePermission, requireAuthenticated, publicAuthConfig, bearerToken } = require('./auth');
const { callJson } = require('./service-client');
const { createConfigResolver } = require('./config-resolver');
const { requireEulaAccepted } = require('./eula');
const { createCorsMiddleware } = require('./cors');
const { initStore, getConversation } = require('@ai-fleet/shared/store');
const events = require('@ai-fleet/shared/messaging/events');
const publish = require('./publish');
const sse = require('./sse');
const { mintStreamToken, mintWorkspaceToken } = require('./stream-token');
const { WORKSPACE_CHANNEL } = require('@ai-fleet/shared/messaging/events');

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

// SSE streams — mounted BEFORE the bearer auth middleware because EventSource
// cannot send an Authorization header; they authorize via a signed stream token
// in the query string instead (see sse.js / stream-token.js). The workspace
// stream carries global status/jobs/coder/gate events (replaces SPA polling) and
// is readable by the public read-only home.
app.get('/api/agent/stream', sse.handleStream);
app.get('/api/agent/workspace-stream', sse.handleWorkspaceStream);

// Attaches req.auth (identity + role + permissions) to every /api request. It
// does NOT deny — authorization is enforced per-router by requirePermission
// below, so unauthenticated visitors get exactly the public surface (read-only
// Agent workspace) and 401/403 on anything else. Local dev is fully open.
app.use('/api', createAuthenticationMiddleware());

// Authenticated identity + resolved permissions. 401 (not 200-with-null) when
// unauthenticated so the SPA can distinguish signed-in from public.
app.get('/api/auth/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.auth || !req.auth.authenticated) {
    return res.status(401).json({ error: 'Authentication required', code: 'authentication_required' });
  }
  return res.json({
    authenticated: true,
    user: req.auth.user,
    role: req.auth.role,
    permissions: req.auth.permissions,
  });
});

// Per-org deployment resolver. The SPA calls this after sign-in to learn which
// front-facing gateway to use (shared vs a provisioned per-tenant stack). Mounted
// WITHOUT requireAuthenticated so anonymous callers get a 200 { authenticated:
// false } and stay same-origin; authenticated callers are resolved against the
// org service by the caller's token (no client-supplied org id). See config-resolver.js.
app.get('/api/config', createConfigResolver());

// Mint a short-lived stream token for the authenticated user to open an SSE
// connection for a specific conversation. AI Fleet is single-tenant by design —
// all fleet:access operators share one store/conversations (see README), so there
// is no per-user ownership boundary to enforce here. We still require the
// conversation to EXIST so tokens can't be minted for arbitrary/guessed ids.
app.get('/api/agent/stream-token', requirePermission('workspace'), (req, res) => {
  const conversationId = String(req.query.conversationId || '').trim();
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required.' });
  if (!getConversation(conversationId)) return res.status(404).json({ error: 'Unknown conversation.' });
  return res.set('Cache-Control', 'no-store').json({ token: mintStreamToken(conversationId), conversationId });
});

// Mint a token for the GLOBAL workspace stream. workspace:READ (public) so the
// read-only home can subscribe to live status/jobs/coder/gate updates. Bound to
// the reserved channel id — no conversation to validate.
app.get('/api/agent/workspace-stream-token', requirePermission('workspace', { level: 'read' }), (req, res) => {
  res.set('Cache-Control', 'no-store').json({ token: mintWorkspaceToken(), conversationId: WORKSPACE_CHANNEL });
});

// EULA gate applied to POST /api/issues only (task creation is "actual work";
// board-drag PATCH and reads pass through). Kept here so all EULA gating lives
// alongside the other gated routes (enqueue, business/prepare) below.
const gateIssueWrites = (() => {
  const gate = requireEulaAccepted();
  return (req, res, next) => (req.method === 'POST' ? gate(req, res, next) : next());
})();

// User-facing API routes (owned by the gateway). Each is guarded by the
// permission domain its feature area belongs to (see packages/shared/authz.js).
// GET → 'read', mutations → 'write'. The codex/claude/roles config surfaces are
// admin-only (settings:write) since only the admin Settings view uses them.
app.use('/api/settings', requirePermission('settings'), settingsRoutes);
app.use('/api/settings/codex', requirePermission('settings', { level: 'write' }), codexRoutes);
app.use('/api/settings/claude', requirePermission('settings', { level: 'write' }), claudeRoutes);
app.use('/api/projects', requirePermission('planning'), projectsRoutes);
// Creating an implementation task (POST) is "actual work" → EULA-gated; the
// board-drag state change (PATCH) and reads are not. Gate only the create.
app.use('/api/issues', requirePermission('planning'), gateIssueWrites, issuesRoutes);
app.use('/api/businesses', requirePermission('planning'), businessesRoutes);
app.use('/api/roles', requirePermission('settings', { level: 'write' }), rolesRoutes);
app.use('/api/observability', requirePermission('insights'), observabilityRoutes);
// Cost-monitoring + billing. 'insights' is the coarse gate (GET → read,
// mutations → write); the router additionally resolves the caller's org
// server-side and requires org-admin for recharge/config (cross-tenant safe).
app.use('/api/billing', requirePermission('insights'), billingRoutes);
// Locale is non-sensitive UI strings — available to public + authenticated.
app.use('/api/locale', localizationRoutes);
// EULA acceptance: GET status is public (anonymous → accepted:false); POST records
// the caller's decision (authenticated only, enforced inside the router). The
// gate below (requireEulaAccepted) enforces acceptance on the actual-work routes.
app.use('/api/eula', eulaRoutes);

// The two long-running request submissions are PUBLISHED (Pub/Sub) rather than
// proxied — they return a conversationId the browser streams via SSE. Registered
// before the proxies so these exact paths win. Both mutate → workspace:write.
app.post('/api/agent/enqueue', requirePermission('workspace'), requireEulaAccepted(), publish.enqueue);
app.post('/api/coder/run', requirePermission('workspace'), publish.coderRun);

// All other agent surfaces are reverse-proxied to their isolated services.
// workspace:read (GET) is public — the read-only Agent home; writes need a role.
const plannerProxy = createProxy(CONFIG.SERVICES.plannerUrl);
// Basic RAG for ANONYMOUS visitors: these two POSTs are side-effect-free reads
// (bounded lexical doc/memory retrieval), so they are authorized at
// workspace:READ even though they are POST — mounted ahead of the catch-all
// /api/agent (which maps POST → write). Everything else on /api/agent still
// needs workspace:write. See docs/ACCESS_MODEL.md.
app.post('/api/agent/knowledge-search', requirePermission('workspace', { level: 'read' }), plannerProxy);
app.post('/api/agent/memory-search', requirePermission('workspace', { level: 'read' }), plannerProxy);
// Preparing a business runs the real 6-stage pipeline (writes) — actual work, so
// it needs EULA acceptance. Registered before the catch-all so this exact path
// wins; everything else on /api/agent keeps the plain workspace:write gate.
app.post('/api/agent/business/prepare', requirePermission('workspace'), requireEulaAccepted(), plannerProxy);
app.use('/api/agent', requirePermission('workspace'), plannerProxy);
app.use('/api/coder', requirePermission('workspace'), createProxy(CONFIG.SERVICES.coderUrl));

// Organization service (FastAPI + Firestore, services/org). It runs its own
// Firebase-OIDC auth + org-scoped RBAC, so the gateway forwards the caller's
// Firebase bearer (forwardUserAuth) and rewrites /api/org/* -> /api/v1/*.
// requirePermission('org') is the coarse gate; the org service enforces the
// real per-organization authorization.
if (CONFIG.SERVICES.orgUrl) {
  const orgProxy = createProxy(CONFIG.SERVICES.orgUrl, {
    rewrite: { from: '/api/org', to: '/api/v1' },
    forwardUserAuth: true,
  });
  // Personal workspace (/api/org/me/*): every SIGNED-IN user may create/manage
  // their own personal projects and create their first org, even without an
  // `org` role (a default viewer only has org:read). Mounted BEFORE the
  // role-gated /api/org so this exact prefix wins. The org service enforces
  // owner-scoping regardless; this is only the coarse authentication gate.
  app.use('/api/org/me', requireAuthenticated(), orgProxy);
  // Org tenant surface — needs the `org` permission domain (org:read for GETs,
  // org:write for mutations). The org service enforces per-org RBAC.
  app.use('/api/org', requirePermission('org'), orgProxy);
} else {
  app.use('/api/org', requirePermission('org'), (req, res) =>
    res.status(501).json({ error: 'Organization service is not configured (ORG_URL unset).' }));
}

// Settings-policy service (FastAPI + Firestore, services/settings). Stores the
// org→project→user include/exclude settings cascade (harness/tools/skills/
// plugins). Like the org service it runs its own Firebase-OIDC auth + org-scoped
// RBAC, so the gateway forwards the caller's Firebase bearer (forwardUserAuth)
// and rewrites /api/settings-policy/* -> /api/v1/*. The `org` permission domain
// is the coarse gate (reused per the epic); the service enforces the real
// per-org / per-project authorization.
// The settings service keeps its OWN user store (separate Firestore namespace)
// and would otherwise see every browser user as org-less, 403-ing real org admins
// on the org-scope surface. The org service is the source of truth, so resolve the
// caller's membership from it (same pull the billing route uses) and hand it to the
// proxy as trusted x-org-* headers. Fail-safe: on any miss we inject nothing, so the
// settings service stays org-less (403) — never a false grant. Never trusts client
// input; org identity is keyed off the authenticated bearer.
async function resolveOrgMembership(req, _res, next) {
  try {
    if (CONFIG.SERVICES.orgUrl) {
      let bearer = '';
      try { bearer = bearerToken(req); } catch (_) { bearer = ''; }
      if (bearer) {
        const { status, data } = await callJson(CONFIG.SERVICES.orgUrl, '/api/v1/me', { userAuth: bearer });
        if (status === 200 && data && data.org_id) {
          req.orgMembership = { orgId: String(data.org_id), orgRole: String(data.org_role || '') };
        }
      }
    }
  } catch (_) {
    /* fail-safe: leave req.orgMembership unset → settings service stays org-less */
  }
  next();
}

if (CONFIG.SERVICES.settingsUrl) {
  const settingsPolicyProxy = createProxy(CONFIG.SERVICES.settingsUrl, {
    rewrite: { from: '/api/settings-policy', to: '/api/v1' },
    forwardUserAuth: true,
    // Only present on the org-scoped mount (set by resolveOrgMembership); absent on
    // the /me mount, so no header is injected there.
    injectHeaders: (req) => (req.orgMembership
      ? { 'x-org-id': req.orgMembership.orgId, 'x-org-role': req.orgMembership.orgRole }
      : {}),
  });
  // The settings service's /api/v1/internal/* surface returns UNMASKED provider
  // secrets and must never be reachable from a browser. Refuse to proxy any
  // `internal` path segment (see settings-internal-guard.js).
  app.use('/api/settings-policy', blockInternalProxy);
  // Personal settings (/api/settings-policy/me/*): every SIGNED-IN user may
  // manage their own user-scope policy, even without an `org` role. Mounted
  // BEFORE the role-gated prefix so this exact path wins (mirrors /api/org/me).
  app.use('/api/settings-policy/me', requireAuthenticated(), settingsPolicyProxy);
  // Org/project settings surface — needs the `org` permission domain; the
  // settings service enforces org-admin / project-admin authorization, using the
  // trusted x-org-* headers resolveOrgMembership injects.
  app.use('/api/settings-policy', requirePermission('org'), resolveOrgMembership, settingsPolicyProxy);
} else {
  app.use('/api/settings-policy', requirePermission('org'), (req, res) =>
    res.status(501).json({ error: 'Settings service is not configured (SETTINGS_URL unset).' }));
}

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
