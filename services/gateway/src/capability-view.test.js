'use strict';

/**
 * GET /api/capabilities — the aggregated read-only view.
 *
 * What these tests hold the code to: the four faces come from the four services
 * that own them, a stage explains WHICH predicate failed rather than only that
 * it failed, an unresolvable face never silently reads as satisfied, and the
 * billing identity is the gateway's own resolution rather than anything the
 * browser sent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCapabilityView, harnessesFace, budgetFace, usageFace, environmentFace,
} = require('./capability-view');

const PREFLIGHT_DECISION = {
  decisionId: 'pd-1',
  ready: true,
  stages: [
    {
      stage: 'plan', workflow: 'planning', harness: 'deepagent', provider: 'openai', modelId: 'gpt-5',
      allowed: true, available: true, supported: true, brokered: true,
      providerReady: true, providerSource: 'managed', providerAuthKind: 'openaiApiKey',
    },
    {
      // Brokered for `coding` but not for `testing`: the only difference an
      // operator can act on, and the reason one boolean would be useless.
      stage: 'code', workflow: 'coding', harness: 'codex-sdk', provider: 'openai', modelId: 'gpt-5-codex',
      allowed: true, available: true, supported: true, brokered: false,
      providerReady: true, providerSource: 'customer', providerAuthKind: 'openaiApiKey',
    },
  ],
};

const ENVIRONMENT_DOC = {
  initialized: true,
  run_id: '2f8a0000-0000-4000-8000-000000000001',
  status: 'RUNNING',
  desired_revision: 'f599cce8a49849c5',
  attempted_revision: 'f599cce8a49849c5',
  trigger: 'LOGIN',
  steps: [
    { key: 'org.seed', status: 'COMPLETED', detail: { project_id: 'p1' }, updated_at: '2026-11-06T10:00:00Z' },
    { key: 'substrate.atespace', status: 'RUNNING', detail: { requested: 'tenant-t3abc' }, updated_at: null },
  ],
  deployment: { status: 'provisioning', gateway_url: 'https://shared.example' },
};

const SUMMARY = {
  bySource: {
    month: {
      retentionDays: 90,
      historyTruncated: true,
      sources: {
        managed: { runs: 4, tokens: 900, costPaise: 250, notionalPaise: 250 },
        customer: { runs: 7, tokens: 1800, costPaise: 0, notionalPaise: 610 },
      },
    },
  },
};

function makeReq({ billingCaller = { orgId: 'org-1', userId: 'user-1', isAdmin: true }, authorization = 'Bearer jwt-1' } = {}) {
  return {
    auth: { authenticated: true },
    billingCaller,
    get: (h) => ({ authorization, 'x-ai-fleet-organization-id': 'org-1', 'x-ai-fleet-project-id': 'proj-1' })[String(h).toLowerCase()],
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

/** A view whose four backends all answer, recording what each was asked. */
function healthy(overrides = {}) {
  const seen = [];
  const handler = createCapabilityView({
    callJson: async (baseUrl, path, opts = {}) => {
      seen.push({ baseUrl, path, ...opts });
      if (path.includes('preflight')) return { status: 200, data: PREFLIGHT_DECISION };
      if (path.includes('summary')) return { status: 200, data: SUMMARY };
      if (path.includes('me/environment')) return { status: 200, data: ENVIRONMENT_DOC };
      return { status: 404, data: null };
    },
    getBillingStatus: () => ({ blocked: false, orgId: 'org-1', balancePaise: 25000, fundStatus: 'available', fundsAvailable: true }),
    getSettings: () => ({ llmProvider: 'ollama' }),
    settingsUrl: 'https://settings.test',
    orgUrl: 'https://org.test',
    billingUrl: 'https://billing.test',
    ...overrides,
  });
  return { handler, seen };
}

test('all four faces are populated from their owning services, and nothing is degraded', async () => {
  const { handler, seen } = healthy();
  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res.headers['cache-control'], 'no-store', 'a capability answer is per-caller and per-minute');
  const body = res.body;
  assert.deepEqual(body.faces, ['harnesses', 'budget', 'modelUsage', 'environment']);
  assert.deepEqual(body.degraded, []);
  assert.equal(body.organizationId, 'org-1');

  const paths = seen.map((call) => call.path);
  assert.deepEqual(paths, [
    '/api/v1/settings/preflight',
    '/api/billing/summary',
    '/api/v1/me/environment',
  ], 'exactly one hop per owning service — no local re-implementation');
  assert.equal(body.harnesses.stages.length, 2);
  assert.equal(body.budget.balanceInr, 250);
  assert.equal(body.modelUsage.sources.customer.notionalPaise, 610);
  assert.equal(body.environment.steps[1].status, 'RUNNING');
});

test('a greyed-out harness says WHICH predicate failed', async () => {
  const { handler } = healthy();
  const res = makeRes();
  await handler(makeReq(), res);

  const [plan, code] = res.body.harnesses.stages;
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.blocking, []);
  assert.equal(code.ready, false);
  assert.deepEqual(code.blocking, [{ predicate: 'brokered', message: 'This workflow needs brokered credentials the platform does not broker.' }]);
  assert.equal(res.body.harnesses.ready, false, 'the conjunction admission actually applies');
  // Components survive, so the SPA can explain rather than merely disable.
  assert.equal(code.available, true);
  assert.equal(code.supported, true);
});

test('the budget face reports the token budget it cannot enforce', async () => {
  const { handler } = healthy();
  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res.body.budget.tokenBudget.configured, false, 'no token-counting gate exists in code');
  assert.match(res.body.budget.tokenBudget.note, /monetary balance/);
  assert.deepEqual(res.body.budget.alertThresholdsPaise, [10000, 0], 'the same constant the alerts use');
});

test('model usage keeps managed spend and the org-owned key in two series', async () => {
  const { handler } = healthy();
  const res = makeRes();
  await handler(makeReq(), res);

  const { sources, retention } = res.body.modelUsage;
  assert.equal(sources.managed.costPaise, 250);
  assert.equal(sources.customer.costPaise, 0, 'the BYOK promise is a visible zero');
  assert.equal(sources.customer.notionalPaise, 610);
  assert.equal(retention.truncated, true, 'a small window may be a pruned window');
  assert.equal(retention.days, 90);
  assert.equal(typeof retention.recordCap, 'number');
});

test('billing identity is the gateway’s resolution, not a browser header', async () => {
  // A client that sends its own x-ai-fleet-billing-* headers must not be able to
  // pick which org's spend this view shows.
  const { handler, seen } = healthy();
  const req = makeReq({ billingCaller: { orgId: 'org-resolved', userId: 'u-2', isAdmin: false } });
  req.headers = { 'x-ai-fleet-billing-org-id': 'org-of-the-attacker' };
  await handler(req, makeRes());

  const billing = seen.find((call) => call.path === '/api/billing/summary');
  assert.deepEqual(billing.headers, {
    'x-ai-fleet-billing-org-id': 'org-resolved',
    'x-ai-fleet-billing-org-role': 'ORG_MEMBER',
    'x-ai-fleet-billing-user-id': 'u-2',
  });
  assert.equal(billing.userAuth, 'jwt-1', 'the bearer still rides along for the service’s own checks');
});

test('a dead settings service degrades one face and never guesses availability', async () => {
  const { handler } = healthy({
    callJson: async (baseUrl, path) => (path.includes('preflight')
      ? { status: 503, data: { error: 'boom' } }
      : { status: 200, data: path.includes('summary') ? SUMMARY : ENVIRONMENT_DOC }),
  });
  const res = makeRes();
  await handler(makeReq(), res);

  assert.deepEqual(res.body.degraded, ['harnesses']);
  assert.equal(res.body.harnesses.ok, false);
  assert.equal(res.body.harnesses.stages, undefined, 'no stages means no implied "all clear"');
  assert.equal(res.body.budget.ok, true, 'the balance the operator needs to fix it is still shown');
  assert.equal(res.body.environment.ok, true);
});

test('a backend that throws is reported, not swallowed', async () => {
  const { handler } = healthy({
    getBillingStatus: () => { throw new Error('store unreachable'); },
    callJson: async (baseUrl, path, opts = {}) => {
      if (path.includes('preflight')) return { status: 200, data: PREFLIGHT_DECISION };
      throw new Error('socket hang up');
    },
  });
  const res = makeRes();
  await handler(makeReq(), res);

  assert.deepEqual(res.body.degraded, ['budget', 'modelUsage', 'environment']);
  assert.equal(res.body.budget.ok, false);
  assert.match(res.body.budget.error, /Balance could not be resolved/);
  assert.match(res.body.modelUsage.error, /Model usage could not be resolved/);
});

test('unconfigured services say so instead of returning empty capabilities', async () => {
  const { handler } = healthy({ billingUrl: '', orgUrl: '' });
  const res = makeRes();
  await handler(makeReq(), res);

  assert.deepEqual(res.body.degraded, ['modelUsage', 'environment']);
  assert.match(res.body.modelUsage.error, /Billing service is not configured/);
  assert.match(res.body.environment.error, /Organization service is not configured/);
  assert.equal(res.body.harnesses.ok, true);
});

// ── the four mappers, on their own ──────────────────────────────────────────

test('budget: a null balance is "no wallet account", not "broke"', () => {
  const face = budgetFace({ blocked: false, balancePaise: null, fundStatus: 'available', fundsAvailable: true }, [10000, 0]);
  assert.equal(face.balancePaise, null);
  assert.equal(face.balanceInr, null);
  assert.equal(face.gateActive, false);
  assert.equal(face.fundsAvailable, true, 'the gate’s verdict passes through, it is not recomputed');
});

test('harnesses: a stage missing a predicate is not silently defaulted to true', () => {
  const face = harnessesFace({ decisionId: 'pd', stages: [{ stage: 'plan', available: true }] });
  assert.equal(face.stages[0].allowed, false);
  assert.equal(face.stages[0].ready, false);
  assert.deepEqual(face.stages[0].blocking.map((b) => b.predicate), ['supported', 'allowed', 'brokered', 'providerReady']);
});

test('environment: the org service’s snake_case stays at the org service', () => {
  const face = environmentFace(ENVIRONMENT_DOC);
  assert.equal(face.runId, ENVIRONMENT_DOC.run_id);
  assert.equal(face.desiredRevision, 'f599cce8a49849c5');
  assert.equal(face.steps[0].updatedAt, '2026-11-06T10:00:00Z');
  assert.deepEqual(face.deployment, { status: 'provisioning', gatewayUrl: 'https://shared.example' });
});

test('usage: an absent window reads as zero activity, not as an error', () => {
  const face = usageFace({ bySource: {} });
  assert.equal(face.ok, true);
  assert.equal(face.sources.managed.runs, 0);
  assert.equal(face.retention.days, null);
  assert.equal(face.retention.truncated, false);
});
