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
    substrate[name] = fn;
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
};

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
        return { id: 'use_1', ...attribution };
      },
    });
    assert.equal(calls.length, 1, 'exactly one usage record per run — never two, never zero');
    assert.equal(calls[0].attribution.orgId, 'org-1');
    assert.equal(calls[0].attribution.projectId, 'proj-1');
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
    assert.equal(record.suspended, true);
    assert.equal(record.deleted, true);
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
