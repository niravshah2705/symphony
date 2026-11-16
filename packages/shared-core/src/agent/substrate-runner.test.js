'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pbString } = require('./grpc-wire');
const substrate = require('./substrate');
const runner = require('./substrate-runner');

/**
 * Stub the ateapi Control plane + the actor data plane so one full
 * runPlanningOnSubstrate lifecycle can be exercised with no cluster. Returns the
 * calls made, so billing assertions can be checked against real traffic.
 */
function stubSubstrate({ actorResponse, record = {} } = {}) {
  const originals = {};
  record.calls = [];
  // Every name that sends something to the control plane. The two resolve*
  // names are absent because they only read config, and the ordering assertion
  // below asks "did this run touch a cluster it should not have".
  const CLUSTER_WRITES = new Set([
    'ensureAtespace', 'upsertActorTemplate', 'createEphemeralActor', 'createActorEgressPolicy',
    'getActorStatus', 'resumeActor', 'suspendActor', 'deleteActor', 'mintActorJwt', 'grpcCall',
  ]);
  const fakes = {
    resolveSubstrateAtespace: () => 'tenant-a',
    resolveSubstrateIngressUrl: () => 'https://substrate.example.com',
    ensureAtespace: async () => ({ atespace: 'tenant-a' }),
    upsertActorTemplate: async () => ({ atespace: 'tenant-a', name: 'planner', created: true }),
    createEphemeralActor: async () => ({ metadata: { atespace: 'tenant-a', name: 'plan-proj-1-run-1' }, status: {} }),
    createActorEgressPolicy: async () => ({ applied: true }),
    getActorStatus: async () => ({ metadata: { name: 'plan-proj-1-run-1' }, status: { state: 'RUNNING' } }),
    resumeActor: async () => ({}),
    suspendActor: async () => { record.suspended = true; return {}; },
    deleteActor: async () => { record.deleted = true; return {}; },
    mintActorJwt: async () => ({ tokenPresent: true }),
    grpcCall: async () => ({ status: 0, firstFrame: pbString(1, 'actor-jwt'), frames: [pbString(1, 'actor-jwt')] }),
  };
  for (const [name, fn] of Object.entries(fakes)) {
    originals[name] = substrate[name];
    substrate[name] = CLUSTER_WRITES.has(name)
      ? async (...args) => { record.calls.push(name); return fn(...args); }
      : fn;
  }
  const fetchImpl = async (url, init) => {
    record.dispatch = { url, init };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(actorResponse),
    };
  };
  const restore = () => {
    for (const [name, fn] of Object.entries(originals)) substrate[name] = fn;
  };
  return { fetchImpl, restore, record };
}

const BASE = {
  organizationId: 'org-1',
  projectId: 'proj-1',
  projectName: 'Project One',
  prompt: 'plan the thing',
  llm: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  traceContext: { runId: 'run-1' },
  userId: 'user-1',
  userEmail: 'user@test.invalid',
};

test('START follows actor creation and STOP precedes teardown, even when dispatch fails', async () => {
  const { restore, record } = stubSubstrate();
  let started;
  let stopped = false;
  try {
    await assert.rejects(runner.runPlanningOnSubstrate({
      ...BASE,
      fetchImpl: async () => { throw new Error('dispatch failed'); },
      actorSessionMonitor: (session) => {
        assert.equal(record.calls.at(-1), 'createEphemeralActor');
        started = session;
        return { stop: () => {
          assert.ok(!record.calls.includes('suspendActor'));
          stopped = true;
        } };
      },
    }), /dispatch failed/);
    assert.equal(started.userId, BASE.userId);
    assert.equal(started.userEmail, BASE.userEmail);
    assert.equal(started.tier, 'standard-1v1g');
    assert.equal(started.hourlyRatePaise, 0);
    assert.equal(stopped, true);
    assert.equal(record.suspended, true);
    assert.equal(record.deleted, true);
  } finally { restore(); }
});

test('a substrate run meters exactly one usage record for the dispatching org', async () => {
  const { fetchImpl, restore, record } = stubSubstrate({
    actorResponse: {
      finalText: 'PLAN',
      messages: [{ role: 'assistant', content: 'PLAN' }],
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
      costUsd: 0.0031,
      traceId: 'trace-xyz',
    },
  });
  const calls = [];
  try {
    const result = await runner.runPlanningOnSubstrate({
      ...BASE,
      fetchImpl,
      recordUsage: (attribution, runResult, llm) => {
        calls.push({ attribution, runResult, llm });
        return { id: 'use_1', billingSource: 'managed', ...attribution };
      },
    });
    assert.equal(calls.length, 1, 'exactly one usage record per run — never two, never zero');
    assert.equal(calls[0].attribution.orgId, 'org-1');
    assert.equal(calls[0].attribution.projectId, 'proj-1');
    assert.equal(calls[0].attribution.userId, 'user-1');
    assert.equal(calls[0].attribution.userEmail, 'user@test.invalid');
    assert.equal(calls[0].attribution.runId, 'run-1');
    assert.equal(calls[0].attribution.traceId, 'trace-xyz');
    assert.equal(calls[0].attribution.source, 'substrate-plan');
    assert.deepEqual(calls[0].runResult.usage, { inputTokens: 100, outputTokens: 200, totalTokens: 300 });
    assert.equal(calls[0].runResult.costUsd, 0.0031);
    assert.equal(calls[0].llm.model, 'claude-sonnet-4-5');

    // The numbers also ride back to the caller, so a pipeline stage can show cost
    // without re-deriving it.
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 200, totalTokens: 300 });
    assert.equal(result.costUsd, 0.0031);
    assert.equal(result.traceId, 'trace-xyz');
    assert.equal(result.billingSource, 'managed');
    assert.equal(record.suspended, true);
    assert.equal(record.deleted, true);
  } finally {
    restore();
  }
});

// A substrate run on the organization's own key must reach the metering call with
// that decision attached. This proves only the hand-off — what the writer does with
// it is usage.test.js's job.
test('the runner hands the admitted credential decision to metering', async () => {
  const { fetchImpl, restore } = stubSubstrate({
    actorResponse: { finalText: 'PLAN', messages: [], usage: { totalTokens: 300 }, costUsd: 0.0031 },
  });
  const calls = [];
  try {
    const result = await runner.runPlanningOnSubstrate({
      ...BASE,
      providerSource: 'customer',
      fetchImpl,
      recordUsage: (attribution) => {
        calls.push(attribution);
        return { id: 'use_2', billingSource: attribution.providerSource === 'customer' ? 'customer' : 'managed' };
      },
    });
    assert.equal(calls[0].providerSource, 'customer');
    assert.equal(result.billingSource, 'customer');
  } finally {
    restore();
  }
});

test('a run with no admitted decision reaches metering with none either', async () => {
  const { fetchImpl, restore } = stubSubstrate({
    actorResponse: { finalText: 'PLAN', messages: [], usage: { totalTokens: 300 } },
  });
  const calls = [];
  try {
    await runner.runPlanningOnSubstrate({
      ...BASE,
      fetchImpl,
      recordUsage: (attribution) => { calls.push(attribution); return null; },
    });
    // Null, not 'managed': the writer owns the conservative default, so the
    // runner must not invent a decision the preflight never made.
    assert.equal(calls[0].providerSource, null);
  } finally {
    restore();
  }
});

test('metering happens on the control plane, not in the actor request body', async () => {
  const { fetchImpl, restore, record } = stubSubstrate({
    actorResponse: { finalText: 'PLAN', messages: [], usage: { totalTokens: 5 } },
  });
  const calls = [];
  try {
    await runner.runPlanningOnSubstrate({
      ...BASE,
      fetchImpl,
      recordUsage: (a, r, l) => { calls.push(a); return null; },
    });
    // The actor is told the org so it can label its own work, but the billing
    // write is ours — a record written inside the actor would vanish with it.
    const body = JSON.parse(record.dispatch.init.body);
    assert.equal(body.organizationId, 'org-1');
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('an actor that reports no usage still records exactly one (skipped) attempt', async () => {
  const { fetchImpl, restore } = stubSubstrate({ actorResponse: { finalText: 'PLAN', messages: [] } });
  const calls = [];
  try {
    const result = await runner.runPlanningOnSubstrate({
      ...BASE,
      fetchImpl,
      recordUsage: (a, r) => { calls.push({ a, r }); return null; },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].r.usage, null);
    assert.equal(result.usage, null);
  } finally {
    restore();
  }
});

test('traceparent crosses the process boundary when the caller has one', async () => {
  const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const { fetchImpl, restore, record } = stubSubstrate({ actorResponse: { finalText: 'P', messages: [] } });
  try {
    await runner.runPlanningOnSubstrate({
      ...BASE,
      traceContext: { runId: 'run-1', traceparent: tp },
      fetchImpl,
      recordUsage: () => null,
    });
    assert.equal(record.dispatch.init.headers.traceparent, tp);
    assert.equal(record.dispatch.init.headers['x-aifleet-run-id'], 'run-1');
    assert.equal(record.dispatch.init.headers['x-aifleet-org-id'], 'org-1');
  } finally {
    restore();
  }
});

test('the actor is still torn down when dispatch fails', async () => {
  const { fetchImpl, restore, record } = stubSubstrate({});
  const boom = async () => { throw new Error('actor unreachable'); };
  try {
    await assert.rejects(
      () => runner.runPlanningOnSubstrate({
        ...BASE,
        fetchImpl: boom,
        recordUsage: () => null,
      }),
      /actor unreachable/,
    );
    assert.equal(record.suspended, true, 'a failed run must not leave an idle actor billing nodes');
    assert.equal(record.deleted, true);
  } finally {
    restore();
  }
});

// The credential-provider Secrets are k8s objects, and Secret CRUD is not an
// ateapi RPC — so writing them needs an injected `applyManifest`, which no
// deployed workload has (the GKE API server is private). What the run does about
// that is the contract, and both wrong answers were live: silently skipping the
// grant left the actor with an unexplained missing token, and throwing AFTER
// ensureAtespace + ActorTemplate landed left a half-provisioned tenant for a run
// that never started.
test('a granted scope with no applier refuses before any cluster write', async () => {
  const { fetchImpl, restore, record } = stubSubstrate({ actorResponse: { finalText: 'P', messages: [] } });
  try {
    await assert.rejects(
      () => runner.runPlanningOnSubstrate({
        ...BASE,
        // The default spec grants github/openrouter/image-registry, so a GitHub
        // token in settings is a grant the caller cannot honor.
        secrets: { githubToken: 'ghp_secretvalue', openrouterApiKey: 'sk-or-secret' },
        fetchImpl,
        recordUsage: () => null,
      }),
      /no applyManifest seam is wired/,
    );
    assert.deepEqual(record.calls, [], 'the refusal must precede every atespace/ActorTemplate/actor write');
    assert.equal(record.suspended, undefined, 'nothing was created, so there is nothing to tear down');
    assert.equal(record.deleted, undefined);
  } finally {
    restore();
  }
});

test('a scope the spec never grants is withheld by name, not an error', async () => {
  const { fetchImpl, restore, record } = stubSubstrate({ actorResponse: { finalText: 'P', messages: [] } });
  try {
    const result = await runner.runPlanningOnSubstrate({
      ...BASE,
      guardrailSpec: { credentials: { scopes: ['image-registry'] } },
      secrets: {
        githubToken: 'ghp_secretvalue',
        imageRegistryPassword: 'ghcr-secret',
        imageRegistryUsername: 'bot',
      },
      applyManifest: async () => {},
      fetchImpl,
      recordUsage: () => null,
    });
    assert.deepEqual(result.substrate.credentialSync.withheld, ['github'],
      'github is present in settings and absent from spec.credentials.scopes');
    assert.equal(result.substrate.credentialSync.scopes.github, false);
    assert.deepEqual(result.substrate.credentialSync.syncedSecrets, ['image-registry-creds'],
      'only the granted scope is written — fail-closed means the scopes the spec grants');

    // Withheld is a policy answer that has to reach the operator, and the
    // raw token must never ride along with it.
    const rendered = JSON.stringify(result);
    assert.ok(!rendered.includes('ghp_secretvalue'), 'the runner response carried a raw GitHub token');
    assert.ok(!rendered.includes('ghcr-secret'), 'the runner response carried a raw registry password');
  } finally {
    restore();
  }
});
