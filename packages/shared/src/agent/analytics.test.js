'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_WINDOW_HOURS,
  MAX_TRACE_LIMIT,
  LANGFUSE_TIMEOUT_SECONDS,
  normalizeOptions,
  normalizeRun,
  aggregateRuns,
  loadAnalytics,
} = require('./analytics');

const ORIGIN = 'https://cloud.langfuse.com';
const PROJECT_BASE = `${ORIGIN}/project/cm1projectid0000abcdef`;
const TRACE_ID = '51c10bb1c398533cdef3921662fb0870';

/** A reconstructed run: dispatch root fields plus the summed child usage. */
function run(overrides = {}) {
  return {
    traceId: TRACE_ID,
    name: 'agent-runtime:deepagent',
    traceName: 'coding',
    level: 'DEFAULT',
    startTime: '2026-11-04T10:00:00.000Z',
    endTime: '2026-11-04T10:00:02.000Z',
    sessionId: 'session-1',
    userId: 'user-1',
    tags: ['runtime:deepagent', 'harness:deepagent', 'model:gpt-5', 'org:org-a', 'project:proj-a'],
    metadata: { agent_runtime: 'deepagent', harness: 'deepagent', model_name: 'gpt-5', project: 'Storefront', 'task-id': 'ENG-7' },
    usage: { input: 100, output: 25, total: 125 },
    cost: { input: 0.01, output: 0.02, total: 0.03 },
    ...overrides,
  };
}

test('analytics query options are bounded', () => {
  const now = new Date('2026-07-16T12:00:00.000Z');
  const options = normalizeOptions({ hours: 99999, limit: 99999, now });
  assert.equal(options.hours, MAX_WINDOW_HOURS);
  assert.equal(options.limit, MAX_TRACE_LIMIT);
  assert.equal(options.startTime.toISOString(), '2026-06-16T12:00:00.000Z');
});

test('runs aggregate cost, tokens, latency, errors, runtime, model, and change identity', () => {
  const result = aggregateRuns([
    run(),
    run({
      traceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      name: 'agent-runtime:codex-sdk',
      level: 'ERROR',
      statusMessage: 'provider rejected the request',
      startTime: '2026-11-04T09:00:00.000Z',
      endTime: '2026-11-04T09:00:04.000Z',
      usage: undefined,
      cost: undefined,
    }),
  ], { traceBase: PROJECT_BASE });

  assert.equal(result.summary.traceCount, 2);
  assert.equal(result.summary.errorCount, 1);
  assert.equal(result.summary.errorRate, 0.5);
  assert.equal(result.summary.totalCostUsd, 0.03);
  assert.equal(result.summary.inputTokens, 100);
  assert.equal(result.summary.outputTokens, 25);
  assert.equal(result.summary.totalTokens, 125);
  assert.equal(result.summary.averageLatencyMs, 3000);
  assert.equal(result.traces[0].change.label, 'ENG-7 · agent-runtime:deepagent');
  assert.equal(result.traces[0].change.project, 'Storefront');
  assert.equal(result.traces[0].change.sessionId, 'session-1');
  assert.equal(result.traces[0].runtime, 'deepagent');
  assert.equal(result.traces[0].model, 'gpt-5');
  assert.equal(result.traces[0].status, 'success');
  assert.equal(result.traces[1].status, 'error');
  assert.match(result.traces[0].traceUrl, new RegExp(`^${ORIGIN}/`));
  // A provider error message stays out of the browser payload.
  assert.equal(JSON.stringify(result).includes('provider rejected the request'), false);
  assert.deepEqual(result.summary.costCoverage, { reported: 1, total: 2 });
});

test('missing usage and cost stay null instead of becoming zero', () => {
  const result = aggregateRuns([run({ usage: undefined, cost: undefined, metadata: {} })]);
  assert.equal(result.summary.totalCostUsd, null);
  assert.equal(result.summary.totalTokens, null);
  assert.equal(result.traces[0].cost.totalUsd, null);
  assert.equal(result.traces[0].cost.source, 'unavailable');
  assert.equal(result.traces[0].tokens.total, null);
});

test('part-reported usage falls back to the sum of its parts', () => {
  const trace = normalizeRun(run({ usage: { input: 40, output: 10 }, cost: { input: 0.4, output: 0.1 } }));
  assert.equal(trace.tokens.total, 50);
  assert.equal(trace.tokens.source, 'reported-parts');
  assert.equal(trace.cost.totalUsd, 0.5);
  assert.equal(trace.cost.source, 'reported-parts');
});
test('trace links stay on the configured Langfuse origin and require a hex trace id', () => {
  assert.equal(
    normalizeRun(run(), { traceBase: PROJECT_BASE }).traceUrl,
    `${PROJECT_BASE}/traces/${TRACE_ID}`
  );
  // A non-hex id cannot walk out of the traces route.
  assert.equal(normalizeRun(run({ traceId: '../../evil' }), { traceBase: PROJECT_BASE }).traceUrl, null);
  // A base on another origin is rejected even when the id is well formed.
  assert.equal(normalizeRun(run(), { traceBase: 'https://evil.example/project/p' }).traceUrl, null);
  assert.equal(normalizeRun(run(), { traceBase: 'https://user:pw@cloud.langfuse.com/project/p' }).traceUrl,
    `${ORIGIN}/project/p/traces/${TRACE_ID}`);
  assert.equal(normalizeRun(run(), {}).traceUrl, null);
});

test('root metadata supplies runtime, model and resource lists', () => {
  const trace = normalizeRun(run({
    metadata: {
      agent_runtime: 'claude-agent-sdk',
      model_name: 'claude-opus-4-8',
      skills: ['commit', 'push'],
      tools: 'web_search, web_search ,docker_build',
      plugins: ['linear'],
      tools_used: ['docker_build'],
      skills_used: ['commit'],
    },
  }));
  assert.equal(trace.runtime, 'claude-agent-sdk');
  assert.equal(trace.model, 'claude-opus-4-8');
  assert.deepEqual(trace.resources, {
    skills: ['commit', 'push'],
    tools: ['web_search', 'docker_build'],
    plugins: ['linear'],
    skillsUsed: ['commit'],
    toolsUsed: ['docker_build'],
    pluginsUsed: [],
  });
  // Names the table derives from tags when metadata is absent.
  const tagged = normalizeRun(run({ metadata: {}, tags: ['runtime:qoder-sdk', 'model:qwen-max'] }));
  assert.equal(tagged.runtime, 'qoder-sdk');
  assert.equal(tagged.model, 'qwen-max');
});

test('aggregateRuns rolls up top resource usage, preferring used over configured', () => {
  const result = aggregateRuns([
    run({ metadata: { tools: ['a', 'b'], tools_used: ['a'] } }),
    run({ metadata: { tools: ['a', 'c'], tools_used: ['a', 'c'] } }),
    run({ metadata: { tools: ['b'] } }),
  ]);
  assert.deepEqual(result.summary.resourceUsage.tools, [
    { name: 'a', count: 2 },
    { name: 'b', count: 1 },
    { name: 'c', count: 1 },
  ]);
  assert.deepEqual(result.summary.resourceUsage.skills, []);
  assert.deepEqual(result.summary.resourceUsage.plugins, []);
});
const SETTINGS = { langfusePublicKey: 'pk-lf-public', langfuseSecretKey: 'sk-lf-secret', langfuseTracing: true };

function rootRow(traceId, name) {
  return {
    traceId,
    name,
    level: 'DEFAULT',
    startTime: '2026-11-04T10:00:00.000Z',
    endTime: '2026-11-04T10:00:01.000Z',
    sessionId: 'session-1',
    tags: [`org:org-a`],
    metadata: { agent_runtime: 'deepagent', model_name: 'gpt-5' },
  };
}

function childRow(traceId) {
  return {
    traceId,
    type: 'GENERATION',
    usageDetails: { input: 10, output: 4, total: 14 },
    inputCost: 0.02,
    outputCost: 0.01,
    totalCost: 0.03,
  };
}

/**
 * Call order is deterministic — root pages, then usage pages, then the project
 * lookup — so pages are served straight off a queue.
 */
function stubClient(pages, project = { data: [{ id: 'cm1projectid0000abcdef' }] }) {
  const queue = [...pages];
  const requests = [];
  return {
    requests,
    api: {
      observations: {
        async getMany(request, options) {
          requests.push({ request, options });
          const next = queue.shift();
          return typeof next === 'function' ? next(request) : { data: [], meta: {}, ...(next || {}) };
        },
      },
      projects: {
        async get() {
          if (project instanceof Error) throw project;
          return project;
        },
      },
    },
  };
}

test('the v2 read is scoped to the environment, the org tag, and logical roots', async () => {
  const client = stubClient([
    { data: [rootRow(TRACE_ID, 'agent-runtime:deepagent')] },
    { data: [childRow(TRACE_ID)] },
  ]);
  const result = await loadAnalytics(SETTINGS, { hours: 24, limit: 10, orgId: 'org-a', now: '2026-11-04T12:00:00.000Z' }, { client });

  assert.equal(result.availability, 'available');
  assert.equal(result.source, 'langfuse');
  assert.equal(client.requests.length, 2);
  const [roots, usage] = client.requests;
  assert.equal(roots.request.isRootObservation, true);
  assert.equal(roots.request.environment, 'dev');
  assert.equal(roots.request.toStartTime, '2026-11-04T12:00:00.000Z');
  assert.match(roots.request.fields, /metadata/);
  assert.ok(!roots.request.fields.includes('io'), 'prompt text is never fetched');
  assert.match(roots.request.expandMetadata, /tools_used/);
  assert.deepEqual(JSON.parse(roots.request.filter), [
    { column: 'tags', type: 'arrayOptions', operator: 'all of', value: ['org:org-a'] },
  ]);
  assert.equal(usage.request.isRootObservation, false);
  const usageFilter = JSON.parse(usage.request.filter);
  assert.deepEqual(usageFilter[1], { column: 'traceId', type: 'stringOptions', operator: 'any of', value: [TRACE_ID] });
  for (const entry of client.requests) {
    assert.equal(entry.options.timeoutInSeconds, LANGFUSE_TIMEOUT_SECONDS);
    assert.equal(entry.options.maxRetries, 0);
  }
  assert.equal(result.summary.traceCount, 1);
  assert.equal(result.summary.totalCostUsd, 0.03);
  assert.equal(result.summary.totalTokens, 14);
  assert.equal(result.traces[0].traceUrl, `${ORIGIN}/project/cm1projectid0000abcdef/traces/${TRACE_ID}`);
});

test('paging follows the cursor, honours the trace limit, and survives an empty page', async () => {
  const pages = [
    { data: [rootRow('a'.repeat(32), 'first')], meta: { cursor: 'page-2' } },
    { data: [], meta: { cursor: 'page-3' } },
    { data: [rootRow('b'.repeat(32), 'second'), rootRow('c'.repeat(32), 'third')], meta: {} },
  ];
  const client = {
    requests: [],
    api: {
      observations: {
        async getMany(request) {
          const isUsage = request.fields === 'core,basic,usage';
          if (isUsage) return { data: [], meta: {} };
          const page = pages.shift() || { data: [], meta: {} };
          client.requests.push(request);
          return page;
        },
      },
      projects: { async get() { return { data: [{ id: 'cm1projectid0000abcdef' }] }; } },
    },
  };
  const result = await loadAnalytics(SETTINGS, { limit: 3, orgId: 'org-a' }, { client });
  // Three root pages (the middle one empty) and no fourth: the limit cut it short.
  assert.equal(client.requests.length, 3);
  assert.equal(result.summary.traceCount, 3);
});
test('usage is summed only for the traces the table shows', async () => {
  const client = stubClient([
    { data: [rootRow('a'.repeat(32), 'first'), rootRow('b'.repeat(32), 'second')] },
    { data: [
      childRow('a'.repeat(32)),
      childRow('a'.repeat(32)),
      childRow('b'.repeat(32)),
      childRow('ff'.repeat(16)), // another trace in the same window
    ] },
  ]);
  const result = await loadAnalytics(SETTINGS, { limit: 2, orgId: 'org-a' }, { client });
  assert.equal(result.summary.traceCount, 2);
  assert.equal(result.summary.totalCostUsd, 0.09);
  assert.equal(result.summary.totalTokens, 42);
});

test('an unusable project lookup drops the deep link but keeps the table', async () => {
  const client = stubClient(
    [{ data: [rootRow(TRACE_ID, 'agent-runtime:deepagent')] }],
    new Error('do-not-leak workspace details')
  );
  const result = await loadAnalytics(SETTINGS, { orgId: 'org-a' }, { client });
  assert.equal(result.availability, 'available');
  assert.equal(result.project, null);
  assert.equal(result.traces[0].traceUrl, null);
  assert.equal(JSON.stringify(result).includes('do-not-leak'), false);
});

test('the client is built from settings against the sidecar-aware base URL', async () => {
  let configuration;
  class StubClient {
    constructor(value) { configuration = value; }
    api = {
      observations: { async getMany() { return { data: [], meta: {} }; } },
      projects: { async get() { throw new Error('unused'); } },
    };
  }
  const result = await loadAnalytics(SETTINGS, {}, { Client: StubClient });
  assert.equal(configuration.publicKey, 'pk-lf-public');
  assert.equal(configuration.secretKey, 'sk-lf-secret');
  assert.ok(configuration.baseUrl.includes('langfuse'), 'the configured Langfuse origin is used');
  assert.equal(result.availability, 'available');
  assert.equal(result.summary.traceCount, 0);
  assert.match(result.message, /No agent runs/);
});

test('analytics degrades honestly when tracing or the keys are unavailable', async () => {
  const disabled = await loadAnalytics({ ...SETTINGS, langfuseTracing: false }, { orgId: 'org-a' });
  assert.equal(disabled.availability, 'unavailable');
  assert.equal(disabled.reason, 'tracing-disabled');

  const missing = await loadAnalytics({ langfusePublicKey: '', langfuseSecretKey: '' }, { orgId: 'org-a' });
  assert.equal(missing.reason, 'keys-missing');
  assert.equal(missing.summary, null);

  const failed = await loadAnalytics(SETTINGS, { orgId: 'org-a' }, {
    client: { api: { observations: { async getMany() { throw new Error('upstream said sk-lf-secret'); } }, projects: { async get() { return { data: [] }; } } } },
  });
  assert.equal(failed.reason, 'provider-unavailable');
  assert.equal(JSON.stringify(failed).includes('sk-lf-secret'), false);
});

test('an empty window reports zero runs rather than an error', async () => {
  const result = await loadAnalytics(SETTINGS, { orgId: 'org-a' }, { client: stubClient([]) });
  assert.equal(result.availability, 'available');
  assert.equal(result.summary.traceCount, 0);
  assert.equal(result.summary.errorRate, 0);
  assert.equal(result.summary.totalCostUsd, null);
});
