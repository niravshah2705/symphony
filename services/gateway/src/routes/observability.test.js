'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toAnalyticsPayload } = require('./observability');

test('observability analytics mapper exposes the stable UI contract', () => {
  const payload = toAnalyticsPayload({
    availability: 'available',
    reason: null,
    message: null,
    window: { hours: 24, limit: 10 },
    summary: {
      traceCount: 1,
      totalCostUsd: 0.42,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      averageLatencyMs: 1500,
      errorRate: 0,
      costCoverage: { reported: 1, total: 1 },
      tokenCoverage: { reported: 1, total: 1 },
      latencyCoverage: { reported: 1, total: 1 },
    },
    traces: [{
      id: 'run-1',
      name: 'Change',
      change: { label: 'ENG-1 · Change' },
      runtime: 'claude-sdk',
      model: 'claude-opus',
      status: 'success',
      startedAt: '2026-07-16T12:00:00.000Z',
      latencyMs: 1500,
      tokens: { total: 120 },
      cost: { totalUsd: 0.42 },
      traceUrl: 'https://smith.langchain.com/run-1',
    }],
  });

  assert.equal(payload.configured, true);
  assert.deepEqual(payload.summary, {
    traces: 1,
    totalCost: 0.42,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    avgLatencyMs: 1500,
    errorRate: 0,
    resourceUsage: { tools: [], skills: [], plugins: [] },
  });
  assert.deepEqual(payload.changes[0], {
    id: 'run-1',
    name: 'ENG-1 · Change',
    runtime: 'claude-sdk',
    model: 'claude-opus',
    status: 'success',
    startTime: '2026-07-16T12:00:00.000Z',
    latencyMs: 1500,
    totalTokens: 120,
    totalCost: 0.42,
    tools: [],
    skills: [],
    plugins: [],
    traceUrl: 'https://smith.langchain.com/run-1',
  });
});

test('observability mapper surfaces resource usage, preferring used over configured', () => {
  const payload = toAnalyticsPayload({
    availability: 'available',
    window: {},
    summary: {
      traceCount: 1,
      resourceUsage: { tools: [{ name: 'docker_build', count: 3 }], skills: [], plugins: [] },
    },
    traces: [{
      id: 'run-1',
      name: 'Change',
      change: { label: 'ENG-1 · Change' },
      tokens: {},
      cost: {},
      resources: {
        skills: ['commit', 'push'],
        tools: ['docker_build', 'linear_graphql'],
        plugins: ['linear'],
        toolsUsed: ['docker_build'],
        skillsUsed: [],
        pluginsUsed: [],
      },
    }],
  });

  // Tools: used present → used wins. Skills/plugins: no used → fall back to configured.
  assert.deepEqual(payload.changes[0].tools, ['docker_build']);
  assert.deepEqual(payload.changes[0].skills, ['commit', 'push']);
  assert.deepEqual(payload.changes[0].plugins, ['linear']);
  assert.deepEqual(payload.summary.resourceUsage.tools, [{ name: 'docker_build', count: 3 }]);
});

test('observability mapper distinguishes missing configuration from provider outage', () => {
  const missing = toAnalyticsPayload({
    availability: 'unavailable', reason: 'api-key-missing', message: 'Configure it.', window: {}, summary: null, traces: [],
  });
  const outage = toAnalyticsPayload({
    availability: 'unavailable', reason: 'provider-unavailable', message: 'Try again.', window: {}, summary: null, traces: [],
  });
  assert.equal(missing.configured, false);
  assert.equal(outage.configured, true);
  assert.equal(outage.summary.totalCost, null);
});
