'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_WINDOW_HOURS,
  MAX_TRACE_LIMIT,
  LANGSMITH_TIMEOUT_MS,
  normalizeOptions,
  aggregateRuns,
  loadAnalytics,
} = require('./analytics');

test('analytics query options are bounded', () => {
  const now = new Date('2026-07-16T12:00:00.000Z');
  const options = normalizeOptions({ hours: 99999, limit: 99999, now });
  assert.equal(options.hours, MAX_WINDOW_HOURS);
  assert.equal(options.limit, MAX_TRACE_LIMIT);
  assert.equal(options.startTime.toISOString(), '2026-06-16T12:00:00.000Z');
});

test('root runs aggregate cost, tokens, latency, errors, runtime, model, and change identity', () => {
  const result = aggregateRuns([
    {
      id: 'run-1',
      trace_id: 'trace-1',
      app_path: '/o/workspace/projects/p/project/r/run-1',
      name: 'Implement checkout',
      run_type: 'chain',
      status: 'success',
      start_time: '2026-07-16T10:00:00.000Z',
      end_time: '2026-07-16T10:00:02.000Z',
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      prompt_cost: '0.01',
      completion_cost: 0.02,
      total_cost: 0.03,
      extra: {
        metadata: { project: 'Storefront', 'task-id': 'ENG-7', runtime: 'codex-sdk', ls_model_name: 'gpt-5' },
      },
    },
    {
      id: 'run-2',
      name: 'Review checkout',
      run_type: 'chain',
      status: 'error',
      error: 'private provider error must not be copied',
      start_time: '2026-07-16T09:00:00.000Z',
      end_time: '2026-07-16T09:00:04.000Z',
    },
  ], { hostUrl: 'https://smith.langchain.com' });

  assert.equal(result.summary.traceCount, 2);
  assert.equal(result.summary.errorCount, 1);
  assert.equal(result.summary.errorRate, 0.5);
  assert.equal(result.summary.totalCostUsd, 0.03);
  assert.equal(result.summary.inputTokens, 100);
  assert.equal(result.summary.outputTokens, 25);
  assert.equal(result.summary.totalTokens, 125);
  assert.equal(result.summary.averageLatencyMs, 3000);
  assert.equal(result.traces[0].change.label, 'ENG-7 · Implement checkout');
  assert.equal(result.traces[0].runtime, 'codex-sdk');
  assert.equal(result.traces[0].model, 'gpt-5');
  assert.match(result.traces[0].traceUrl, /^https:\/\/smith\.langchain\.com\//);
  assert.equal(JSON.stringify(result).includes('private provider error'), false);
  assert.deepEqual(result.summary.costCoverage, { reported: 1, total: 2 });
});

test('missing cost and token telemetry stays null instead of becoming zero', () => {
  const result = aggregateRuns([{ id: 'run-1', name: 'No usage fields' }]);
  assert.equal(result.summary.totalCostUsd, null);
  assert.equal(result.summary.totalTokens, null);
  assert.equal(result.traces[0].cost.totalUsd, null);
  assert.equal(result.traces[0].tokens.total, null);
});

test('trace links stay on the trusted LangSmith origin', () => {
  const result = aggregateRuns([
    { id: 'valid', app_path: '/o/workspace/projects/p/project/r/valid' },
    { id: 'protocol-relative', app_path: '//evil.example/steal' },
    { id: 'backslash-relative', app_path: '/\\evil.example/steal' },
  ], { hostUrl: 'https://user:password@smith.langchain.com' });

  assert.equal(result.traces.find((trace) => trace.id === 'valid').traceUrl,
    'https://smith.langchain.com/o/workspace/projects/p/project/r/valid');
  assert.equal(result.traces.find((trace) => trace.id === 'protocol-relative').traceUrl, null);
  assert.equal(result.traces.find((trace) => trace.id === 'backslash-relative').traceUrl, null);
});

test('SDK trace metadata supplies usage and cost when LangSmith run totals are absent', () => {
  const result = aggregateRuns([{
    id: 'sdk-run',
    name: 'agent-runtime:claude-agent-sdk',
    extra: {
      metadata: {
        agent_runtime: 'claude-agent-sdk',
        model_name: 'claude-opus-4-8',
        usage_input_tokens: 300,
        usage_output_tokens: 70,
        usage_total_tokens: 370,
        cost_usd: 0.19,
      },
    },
  }]);
  const trace = result.traces[0];
  assert.equal(trace.runtime, 'claude-agent-sdk');
  assert.equal(trace.model, 'claude-opus-4-8');
  assert.deepEqual(trace.tokens, { total: 370, prompt: 300, completion: 70, source: 'trace-metadata' });
  assert.equal(trace.cost.totalUsd, 0.19);
  assert.equal(trace.cost.source, 'trace-metadata');
  assert.equal(result.summary.totalCostUsd, 0.19);
});

test('LangSmith query uses a bounded root-run window and limit', async () => {
  let query;
  const client = {
    getHostUrl: () => 'https://smith.langchain.com',
    async *listRuns(input) {
      query = input;
      yield { id: 'a', name: 'A' };
      yield { id: 'b', name: 'B' };
    },
  };
  const result = await loadAnalytics(
    { langsmithTracing: true, langsmithApiKey: 'secret', langsmithProject: 'project' },
    { hours: 12, limit: 1, now: new Date('2026-07-16T12:00:00.000Z') },
    { client }
  );
  assert.equal(query.isRoot, true);
  assert.equal(query.limit, 1);
  assert.equal(query.startTime.toISOString(), '2026-07-16T00:00:00.000Z');
  assert.equal(result.traces.length, 1);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('LangSmith client construction has a bounded request timeout and retry count', async () => {
  let configuration;
  class StubClient {
    constructor(value) { configuration = value; }
    async *listRuns() {}
  }
  await loadAnalytics(
    { langsmithTracing: true, langsmithApiKey: 'secret', langsmithProject: 'project' },
    { now: '2026-07-16T12:00:00.000Z' },
    { Client: StubClient }
  );
  assert.equal(configuration.timeout_ms, LANGSMITH_TIMEOUT_MS);
  assert.deepEqual(configuration.callerOptions, { maxRetries: 1 });
});

test('analytics degrades honestly when tracing or LangSmith is unavailable', async () => {
  const disabled = await loadAnalytics({ langsmithTracing: false }, { now: '2026-07-16T12:00:00.000Z' });
  assert.equal(disabled.availability, 'unavailable');
  assert.equal(disabled.reason, 'tracing-disabled');

  const failed = await loadAnalytics(
    { langsmithTracing: true, langsmithApiKey: 'do-not-leak', langsmithProject: 'project' },
    { now: '2026-07-16T12:00:00.000Z' },
    { client: { listRuns() { throw new Error('upstream returned do-not-leak'); } } }
  );
  assert.equal(failed.reason, 'provider-unavailable');
  assert.equal(JSON.stringify(failed).includes('do-not-leak'), false);
});
