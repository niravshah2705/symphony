'use strict';

const express = require('express');
const path = require('path');
const { CONFIG } = require('@ai-fleet/shared-core/config');
const { sendError } = require('@ai-fleet/shared-core/util');
const log = require('@ai-fleet/shared-core/logger');

const billingRoutes = require('./routes/billing');
const eulaRoutes = require('./routes/eula');
const { createPipelineRouter } = require('./routes/pipeline');
const { createProxy } = require('./proxy');
const { blockInternalProxy } = require('./settings-internal-guard');
const { mountRemovedAgentRouteTombstones } = require('./removed-agent-routes');
const { createAuthenticationMiddleware, requirePermission, requireAuthenticated, publicAuthConfig, bearerToken } = require('./auth');
const { callJson } = require('./service-client');
const { createConfigResolver } = require('./config-resolver');
const { requireEulaAccepted } = require('./eula');
const { createCorsMiddleware } = require('./cors');
const { initStore, getConversation } = require('@ai-fleet/shared-core/store');
const events = require('@ai-fleet/shared-core/messaging/events');
const { createCompatibilityHandlers } = require('./publish');
const sse = require('./sse');
const { mintStreamToken, mintWorkspaceToken } = require('./stream-token');
const { createStreamTokenHandlers } = require('./stream-token-handlers');
const { configureTrustProxy } = require('./trust-proxy');
const { enforcePinnedOrganization, requestContext, requireOrganizationContext, notificationsRequested } = require('./request-context');
const { createContextValidationMiddleware } = require('./context-validator');
const { createStoreContextMiddleware } = require('./store-context');
const { createApiDocsGate, serveSwaggerJson, createSwaggerMiddleware, createSwaggerUISetup } = require('./swagger');

const { PipelineAdmissionError, createPipelineAdmission } = require('./pipeline-admission');
const pipelineAdmission = createPipelineAdmission();
const publish = createCompatibilityHandlers({ admission: pipelineAdmission });
const streamTokenHandlers = createStreamTokenHandlers({
  mintStreamToken,
  mintWorkspaceToken,
  requestContext,
  getConversation,
  matchesEventContext: events.matchesEventContext,
});

/**
 * Gateway service — the single browser-facing origin. It serves the SPA, owns
 * the user-facing auth, billing, EULA, publishing, and SSE boundaries, and
 * reverse-proxies model/agent/domain APIs to their isolated services:
 *   /api/agent/*  → planner service (CONFIG.SERVICES.plannerUrl)
 *   /api/coder/*  → coder service   (CONFIG.SERVICES.coderUrl)
 * The frontend keeps calling same-origin /api/* paths and is unaware of the
 * split.
 */
const app = express();

// Cloud Run is the one trusted reverse-proxy hop in the documented direct
// browser -> gateway topology. This makes req.ip useful for advisory locale
// recommendations without trusting an arbitrary leftmost X-Forwarded-For.
configureTrustProxy(app);

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

// Swagger/OpenAPI documentation — gated by x-ai-fleet-api-docs header in production.
// Local dev (non-cloud): always available. Cloud deployments: require header (any value).
// Serve the OpenAPI spec and the interactive Swagger UI.
app.get('/swagger.json', serveSwaggerJson());
app.use('/api/docs', createApiDocsGate(), createSwaggerMiddleware(), createSwaggerUISetup());

// Removed Codex browser credential routes (OAuth and sign-out) must never fall
// through to auth, a proxy, or the local SPA. Stable no-store 410s tell old
// clients to stop retrying.
mountRemovedAgentRouteTombstones(app);

// Local multi-process event collector: worker services POST their conversation
// events here and the gateway injects them into its in-process bus for SSE.
// Disabled in the cloud (EVENTS_BACKEND=firestore fans out via onSnapshot).
app.post('/internal/events', (req, res) => {
  if (CONFIG.EVENTS_BACKEND === 'firestore') return res.status(404).end();
  const { conversationId, event, context } = req.body || {};
  events.ingest(conversationId, event, context);
  return res.status(204).end();
});

// Public Benchmarks API endpoint for ArchAgentix
app.get('/api/benchmarks', (req, res) => {
  try {
    const catalog = [
      {
        id: "deepseek-v3",
        name: "DeepSeek V3",
        provider: "DeepSeek",
        model_type: "open_source",
        parameters: { total: "671B", active: "37B", context_window: 128000 },
        cost: { prompt_per_1m: 0.14, completion_per_1m: 0.28, cached_input_per_1m: 0.014 },
        features: { prompt_cache_supported: true, cache_discount_pct: 90, auto_fallback_enabled: true, fallback_targets: ["Qwen 2.5 72B Instruct"], rate_limits: { rpm: 5000, tpm: 2000000, concurrent: 100 } },
        benchmarks: { swe_bench: 49.2, mmlu_pro: 75.6, human_eval: 90.2, gpqa: 59.1, output_tps: 65 },
        hosting: { regions: ["us-central1", "europe-west1", "asia-east1"], distributors: [{ name: "DeepSeek Direct", prompt_cost: 0.14, completion_cost: 0.28 }, { name: "Together AI", prompt_cost: 0.60, completion_cost: 0.60 }], uptime_link: "https://status.deepseek.com", paper_link: "https://github.com/deepseek-ai/DeepSeek-V3", weights_link: "https://huggingface.co/deepseek-ai/DeepSeek-V3" },
        simple_score: 92.4,
        rank: 1
      },
      {
        id: "qwen-2-5-coder-32b",
        name: "Qwen 2.5 Coder 32B",
        provider: "Alibaba Cloud",
        model_type: "open_source",
        parameters: { total: "32B", active: "32B", context_window: 128000 },
        cost: { prompt_per_1m: 0.08, completion_per_1m: 0.16, cached_input_per_1m: 0.02 },
        features: { prompt_cache_supported: true, cache_discount_pct: 75, auto_fallback_enabled: true, fallback_targets: ["Qwen 2.5 14B Coder"], rate_limits: { rpm: 3000, tpm: 1500000, concurrent: 60 } },
        benchmarks: { swe_bench: 41.2, mmlu_pro: 69.4, human_eval: 92.7, gpqa: 48.5, output_tps: 85 },
        hosting: { regions: ["cn-hangzhou", "us-central1"], distributors: [{ name: "Alibaba DashScope", prompt_cost: 0.08, completion_cost: 0.16 }, { name: "Together AI", prompt_cost: 0.20, completion_cost: 0.20 }], uptime_link: "https://status.alibabacloud.com", paper_link: "https://qwenlm.github.io/blog/qwen2.5-coder/", weights_link: "https://huggingface.co/Qwen/Qwen2.5-Coder-32B-Instruct" },
        simple_score: 89.8,
        rank: 2
      },
      {
        id: "claude-3-5-sonnet",
        name: "Claude 3.5 Sonnet",
        provider: "Anthropic",
        model_type: "proprietary",
        parameters: { total: "Undisclosed", active: "Undisclosed", context_window: 200000 },
        cost: { prompt_per_1m: 3.00, completion_per_1m: 15.00, cached_input_per_1m: 0.30 },
        features: { prompt_cache_supported: true, cache_discount_pct: 90, auto_fallback_enabled: true, fallback_targets: ["Claude 3.5 Haiku"], rate_limits: { rpm: 4000, tpm: 400000, concurrent: 80 } },
        benchmarks: { swe_bench: 49.0, mmlu_pro: 78.0, human_eval: 93.7, gpqa: 65.0, output_tps: 72 },
        hosting: { regions: ["us-east-1", "us-west-2"], distributors: [{ name: "Anthropic Direct", prompt_cost: 3.00, completion_cost: 15.00 }, { name: "AWS Bedrock", prompt_cost: 3.00, completion_cost: 15.00 }], uptime_link: "https://status.anthropic.com", paper_link: "https://www.anthropic.com/news/claude-3-5-sonnet", weights_link: null },
        simple_score: 88.6,
        rank: 3
      },
      {
        id: "gpt-4o",
        name: "GPT-4o",
        provider: "OpenAI",
        model_type: "proprietary",
        parameters: { total: "Undisclosed", active: "Undisclosed", context_window: 128000 },
        cost: { prompt_per_1m: 2.50, completion_per_1m: 10.00, cached_input_per_1m: 1.25 },
        features: { prompt_cache_supported: true, cache_discount_pct: 50, auto_fallback_enabled: true, fallback_targets: ["GPT-4o mini"], rate_limits: { rpm: 10000, tpm: 3000000, concurrent: 500 } },
        benchmarks: { swe_bench: 38.8, mmlu_pro: 72.6, human_eval: 90.2, gpqa: 53.6, output_tps: 105 },
        hosting: { regions: ["us-east-1", "sweden-central"], distributors: [{ name: "OpenAI Direct", prompt_cost: 2.50, completion_cost: 10.00 }, { name: "Azure OpenAI", prompt_cost: 2.50, completion_cost: 10.00 }], uptime_link: "https://status.openai.com", paper_link: "https://openai.com/index/hello-gpt-4o/", weights_link: null },
        simple_score: 83.1,
        rank: 4
      }
    ];

    res.set('Cache-Control', 'public, max-age=300, s-maxage=600');
    let items = catalog;
    const { provider, model_type, min_swe, limit = 50 } = req.query || {};

    if (provider) items = items.filter(m => m.provider.toLowerCase() === provider.toLowerCase());
    if (model_type) items = items.filter(m => m.model_type.toLowerCase() === model_type.toLowerCase());
    if (min_swe) items = items.filter(m => (m.benchmarks?.swe_bench || 0) >= parseFloat(min_swe));

    const limitNum = parseInt(limit, 10);
    return res.json({ status: 'success', total: items.length, count: Math.min(items.length, limitNum), data: items.slice(0, limitNum) });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// The Firebase Web SDK is a static asset under public/vendor/firebase/ (served
// by express.static locally and from GCS in the cloud) — no gateway route needed.

// SSE streams — mounted BEFORE the bearer auth middleware because EventSource
// cannot send an Authorization header; they authorize via a signed stream token
// in the query string instead (see sse.js / stream-token.js). The workspace
// stream carries selected-context status/jobs/coder/gate events (replaces SPA
// polling). Tokens are minted only after authenticated context validation.
app.get('/api/agent/stream', sse.handleStream);
app.get('/api/agent/workspace-stream', sse.handleWorkspaceStream);

// Attaches req.auth (identity + role + permissions) to every /api request. It
// does NOT deny — authorization is enforced per-router by requirePermission
// below, so unauthenticated visitors get exactly the public surface (read-only
// Agent workspace) and 401/403 on anything else. Local dev is fully open.
app.use('/api', createAuthenticationMiddleware());

// A provisioned tenant gateway is pinned to one organization/store namespace.
// Never let a client carry another organization selection into that stack.
app.use('/api', enforcePinnedOrganization(CONFIG.BILLING.orgId));
app.use('/api', createContextValidationMiddleware());
// Select the store only after the org service has validated the browser's
// requested pair. The middleware ignores raw headers and binds req.fleetContext.
app.use('/api', createStoreContextMiddleware());

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
    // Off by default — see request-context.js NOTIFICATIONS_HEADER.
    notificationsEnabled: notificationsRequested(req),
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
app.get('/api/agent/stream-token', requireAuthenticated(), requirePermission('workspace'), requireOrganizationContext(), streamTokenHandlers.mintConversation);

// Mint a token for the selected workspace stream. Bound to the reserved channel
// id and the authoritative organization/project context.
app.get('/api/agent/workspace-stream-token', requireAuthenticated(), requirePermission('workspace', { level: 'read' }), requireOrganizationContext(), streamTokenHandlers.mintWorkspace);

// EULA gate applied to POST /api/issues only (task creation is "actual work";
// board-drag PATCH and reads pass through). Kept here so all EULA gating lives
// alongside the other gated routes (enqueue, business/prepare) below.
const gateIssueWrites = (() => {
  const gate = requireEulaAccepted();
  return (req, res, next) => (req.method === 'POST' ? gate(req, res, next) : next());
})();

const plannerProxy = createProxy(CONFIG.SERVICES.plannerUrl);
const localeProxy = createProxy(CONFIG.SERVICES.plannerUrl, {
  // The planner otherwise sees the gateway socket and loses coarse locale
  // discovery. Only server-derived, bounded values are injected.
  injectHeaders: (req) => ({
    'x-ai-fleet-client-ip': req.ip || '',
    'accept-language': String((req.get && req.get('accept-language')) || '').slice(0, 512),
  }),
});

// The gateway owns browser authentication/authorization; the planner owns the
// heavy implementations. Public URLs remain unchanged. Mount provider routes
// before the general settings prefix so their stricter write-only gate wins.
app.use('/api/settings/codex', requirePermission('settings', { level: 'write' }), requireOrganizationContext(), plannerProxy);
app.use('/api/settings/claude', requirePermission('settings', { level: 'write' }), requireOrganizationContext(), plannerProxy);
app.use('/api/settings', requirePermission('settings'), requireOrganizationContext(), plannerProxy);
app.use('/api/projects', requirePermission('planning'), requireOrganizationContext(), plannerProxy);
// Creating an implementation task (POST) is "actual work" → EULA-gated; the
// board-drag state change (PATCH) and reads are not. Gate only the create.
app.use('/api/issues', requirePermission('planning'), requireOrganizationContext(), gateIssueWrites, plannerProxy);
app.use('/api/businesses', requirePermission('planning'), requireOrganizationContext(), plannerProxy);
app.use('/api/roles', requirePermission('settings', { level: 'write' }), requireOrganizationContext(), plannerProxy);
app.use('/api/observability', requirePermission('insights'), requireOrganizationContext(), plannerProxy);
// Cost-monitoring + billing. Forwarded to the dedicated Cloud Run billing
// service when configured, with user authentication and selected-org context.
// Webhook route from Cashfree bypasses session auth (HMAC-verified at billing).
if (CONFIG.SERVICES.billingUrl) {
  const billingProxy = createProxy(CONFIG.SERVICES.billingUrl, {
    forwardUserAuth: true,
  });
  app.post('/api/billing/cashfree/webhook', billingProxy);
  app.use('/api/billing', requireAuthenticated(), billingProxy);
} else {
  app.use('/api/billing', requireAuthenticated(), billingRoutes);
}
// Locale is non-sensitive UI strings — available to public + authenticated.
// Translation is model-backed, so both locale routes execute in the planner.
app.use('/api/locale', localeProxy);
// EULA acceptance: GET status is public (anonymous → accepted:false); POST records
// the caller's decision (authenticated only, enforced inside the router). The
// gate below (requireEulaAccepted) enforces acceptance on the actual-work routes.
app.use('/api/eula', eulaRoutes);

// Canonical durable pipeline control plane. All starts pass through settings
// preflight and the SDK-free local billing gate before S2S dispatch.
app.use('/api/pipeline', requireAuthenticated(), requirePermission('workspace'), requireOrganizationContext(), createPipelineRouter({
  admission: pipelineAdmission,
  startMiddleware: requireEulaAccepted(),
}));

// Compatibility starts retain their legacy publishers until the orchestrator
// rollout switch is enabled, then use fixed plan-only/code-only admission.
// Registered before the proxies so these exact paths win.
app.post('/api/agent/enqueue', requirePermission('workspace'), requireOrganizationContext(), requireEulaAccepted(), publish.enqueue);
app.post('/api/coder/run', requirePermission('workspace'), requireOrganizationContext(), publish.coderRun);

// All other agent surfaces are reverse-proxied to their isolated services.
// Tenant state (jobs, conversations, memories, status, and configured model
// discovery) requires a signed-in identity. Only the reviewed documentation
// search below is public; otherwise an empty public context could expose legacy
// or another tenant's shared-stack records.
// Basic RAG over the reviewed repository documentation is safe for anonymous
// visitors even though it uses POST for a bounded query body.
app.post('/api/agent/knowledge-search', requirePermission('workspace', { level: 'read' }), plannerProxy);
// Preparing a business runs the real 6-stage pipeline (writes) — actual work, so
// it needs EULA acceptance. Registered before the catch-all so this exact path
// wins; everything else on /api/agent keeps the plain workspace:write gate.
app.post('/api/agent/business/prepare', requirePermission('workspace'), requireOrganizationContext(), requireEulaAccepted(), plannerProxy);
// Attachment upload/ingest and the LLM-backed "ask" both do real work (GCS
// writes, embedding calls, a hosted LLM call) — EULA-gated like business/prepare,
// registered before the catch-all so these exact paths win. Read-only attachment
// routes (list/search/attachment-types) and delete fall through to the plain
// workspace:write gate below, same as conversation delete.
app.post('/api/agent/conversations/:id/attachments', requirePermission('workspace'), requireOrganizationContext(), requireEulaAccepted(), plannerProxy);
app.post('/api/agent/conversations/:id/attachments/:attachmentId/complete', requirePermission('workspace'), requireOrganizationContext(), requireEulaAccepted(), plannerProxy);
app.post('/api/agent/conversations/:id/attachments/ask', requirePermission('workspace'), requireOrganizationContext(), requireEulaAccepted(), plannerProxy);
app.use('/api/agent', requireAuthenticated(), requirePermission('workspace'), requireOrganizationContext(), plannerProxy);
app.use('/api/coder', requireAuthenticated(), requirePermission('workspace'), requireOrganizationContext(), createProxy(CONFIG.SERVICES.coderUrl));

// Identity verification service (DigiLocker / PAN / age proof / APAAR / NAD).
// Browser calls stay same-origin and are scoped by authenticated user plus the
// selected organization. The service owns provider OAuth state and identity
// uniqueness claims; gateway only enforces coarse access/context.
if (CONFIG.SERVICES.identityUrl) {
  const identityProxy = createProxy(CONFIG.SERVICES.identityUrl, {
    rewrite: { from: '/api/identity', to: '' },
    injectHeaders: (req) => ({
      'x-ai-fleet-user-id': req.auth && req.auth.user ? String(req.auth.user.sub || req.auth.user.email || '') : '',
    }),
  });
  app.use('/api/identity', requireAuthenticated(), requirePermission('workspace'), requireOrganizationContext(), identityProxy);
} else {
  app.use('/api/identity', requireAuthenticated(), (req, res) =>
    res.status(501).json({ error: 'Identity verification service is not configured (IDENTITY_URL unset).' }));
}

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
  // Org roles vary with the selected organization, so a global Firebase role
  // cannot be the authorization source here. Require identity at the gateway;
  // the org service validates the selected membership and enforces per-org RBAC.
  app.use('/api/org', requireAuthenticated(), orgProxy);
} else {
  app.use('/api/org', requireAuthenticated(), (req, res) =>
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
  // The settings service's /api/v1/internal/* and /api/v1/operator/* surfaces
  // are privileged and must never be reachable from a browser. Refuse to proxy
  // either path segment (see settings-internal-guard.js).
  app.use('/api/settings-policy', blockInternalProxy);
  // Personal settings (/api/settings-policy/me/*): every SIGNED-IN user may
  // manage their own user-scope policy, even without an `org` role. Mounted
  // BEFORE the role-gated prefix so this exact path wins (mirrors /api/org/me).
  app.use('/api/settings-policy/me', requireAuthenticated(), settingsPolicyProxy);
  // As above, selected org/project roles are context-dependent and resolved by
  // the settings service from the canonical org service on every request.
  app.use('/api/settings-policy', requireAuthenticated(), settingsPolicyProxy);
} else {
  app.use('/api/settings-policy', requireAuthenticated(), (req, res) =>
    res.status(501).json({ error: 'Settings service is not configured (SETTINGS_URL unset).' }));
}

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
  if (err instanceof PipelineAdmissionError) {
    return res.status(err.status || 500).json({
      error: err.message || 'Server error.',
      code: err.code,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
  }
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
