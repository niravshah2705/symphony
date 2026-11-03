'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeCoverage, invalidateCoverageCache, MAX_QUESTIONS_PER_RUN } = require('./coverage-service');

const QUESTIONS = [
  { id: 'gq_org_01', category: 'organisation', subDimension: 'org_size', question: 'How many people are in the organisation?', active: true },
  { id: 'gq_per_01', category: 'person', subDimension: 'identity_role', question: 'What is your role?', active: true },
  { id: 'gq_pb_01', category: 'project_business', subDimension: 'business_domain', question: 'What is the business domain?', active: true },
];

const POOL = [
  { id: 'mem_1', scope: 'business', title: 'Headcount', text: 'The company has 240 staff.', embedding: [1, 0] },
  { id: 'mem_2', scope: 'user', title: 'Role', text: 'Dinesh is the VP of Platform.', embedding: [0, 1] },
  { id: 'mem_3', scope: 'workspace', title: 'Seats', text: '240 staff total.', embedding: [1, 1] },
];

/**
 * Recall fake with an explicit hit plan keyed by question text, so scores are
 * predictable rather than an artifact of the fake's own term splitting. Hits are
 * filtered to the pool the caller passed, which proves the service threads its
 * single loaded pool through every question instead of re-reading the store.
 */
const HIT_PLAN = {
  'How many people are in the organisation?': [
    { memory: { id: 'mem_1', scope: 'business', title: 'Headcount', text: 'The company has 240 staff; about 180 use it daily.' }, score: 0.92 },
    { memory: { id: 'mem_3', scope: 'workspace', title: 'Seats', text: '240 staff total.' }, score: 0.6 },
  ],
  'What is your role?': [
    { memory: { id: 'mem_2', scope: 'user', title: 'Role', text: 'Dinesh is the VP of Platform.' }, score: 0.8 },
  ],
  'What is the business domain?': [],
};

function makeStore({ calls = [], pool = POOL, postgres = false, failLoad = false, plan = HIT_PLAN } = {}) {
  return {
    isPostgresActive: () => postgres,
    async load() {
      calls.push('load');
      if (failLoad) return null;
      return pool;
    },
    async recallScored({ query, memories }) {
      calls.push(`recall:${query}`);
      const ids = new Set((memories || []).map((memory) => memory.id));
      return (plan[query] || []).filter((entry) => ids.has(entry.memory.id));
    },
  };
}

function baseDeps(overrides = {}) {
  return { isMemoryEnabled: () => true, layaUrl: '', ...overrides };
}

test.beforeEach(() => invalidateCoverageCache());

test('with memory disabled nothing is assessed and no recall is attempted', async () => {
  const calls = [];
  const report = await computeCoverage({
    questions: QUESTIONS,
    context: { organizationId: 'org_a' },
    deps: baseDeps({ isMemoryEnabled: () => false, memoryStore: makeStore({ calls }) }),
  });

  assert.equal(report.memoryState, 'disabled');
  assert.equal(report.status, 'not_assessed');
  assert.equal(report.overall.score, null);
  assert.equal(report.overall.status, 'not_assessed');
  assert.equal(report.results.length, 3);
  assert.ok(report.results.every((row) => row.status === 'not_assessed' && row.score === null));
  assert.equal(calls.length, 0, 'a disabled backend must not be probed');
  assert.equal(report.layaApplied, false);
  assert.equal(report.layaReason, 'not_attempted');
});

test('one store load serves the whole bank — questions never re-read the pool', async () => {
  const calls = [];
  const report = await computeCoverage({
    questions: QUESTIONS,
    context: { organizationId: 'org_a' },
    deps: baseDeps({ memoryStore: makeStore({ calls }) }),
  });

  assert.equal(calls.filter((c) => c === 'load').length, 1, 'the pool loads exactly once per run');
  assert.equal(calls.filter((c) => c.startsWith('recall:')).length, 3, 'one scoring pass per question');
  assert.equal(report.status, 'complete');
  assert.equal(report.memoryState, 'lexical');
  assert.equal(report.overall.questionCount, 3);

  const org = report.results.find((row) => row.id === 'gq_org_01');
  assert.equal(org.matchedScopes.includes('business'), true);
  assert.ok(org.score > 0, 'a matching memory must score above zero');
  assert.equal(org.evidence[0].memoryId, 'mem_1');
  assert.ok(org.score <= 100);
});

test('an unreadable store reads as unconfigured, not as 0% coverage', async () => {
  const report = await computeCoverage({
    questions: QUESTIONS,
    context: { organizationId: 'org_a' },
    deps: baseDeps({ memoryStore: makeStore({ failLoad: true }) }),
  });
  assert.equal(report.memoryState, 'unconfigured');
  assert.equal(report.overall.status, 'not_assessed');
  assert.equal(report.overall.score, null, 'must not report "we know nothing" when the store failed');
});

test('a genuinely empty memory is real 0% coverage, distinct from not_assessed', async () => {
  const report = await computeCoverage({
    questions: QUESTIONS,
    context: { organizationId: 'org_a' },
    deps: baseDeps({ memoryStore: makeStore({ pool: [] }) }),
  });
  assert.equal(report.memoryCount, 0);
  assert.equal(report.status, 'complete');
  assert.equal(report.overall.status, 'unanswered');
  assert.equal(report.overall.score, 0);
});

test('embeddings are one batched call, and an embedder failure degrades to lexical', async () => {
  const batches = [];
  const report = await computeCoverage({
    questions: QUESTIONS,
    context: { organizationId: 'org_a' },
    deps: baseDeps({
      memoryStore: makeStore({ postgres: true }),
      embed: async (texts) => { batches.push(texts); return texts.map(() => [1, 0]); },
      loadVector: (memory) => memory.embedding,
    }),
  });
  assert.equal(report.memoryState, 'vector');
  assert.equal(batches.length, 1, 'all question texts embed in one call');
  assert.equal(batches[0].length, 3);

  invalidateCoverageCache();
  const failing = await computeCoverage({
    questions: QUESTIONS,
    context: { organizationId: 'org_a' },
    deps: baseDeps({
      memoryStore: makeStore({ postgres: true }),
      embed: async () => { throw new Error('embeddings request failed (503)'); },
      loadVector: (memory) => memory.embedding,
    }),
  });
  assert.equal(failing.status, 'complete', 'a dead embedder is a lexical-only run, not an error');
});

test('laya is reported as not_configured when no URL is deployed, and cannot change a score', async () => {
  const calls = [];
  const withoutLaya = await computeCoverage({
    questions: QUESTIONS,
    context: { organizationId: 'org_a' },
    deps: baseDeps({ layaUrl: '', memoryStore: makeStore({ calls }) }),
  });
  assert.equal(withoutLaya.layaApplied, false);
  assert.equal(withoutLaya.layaReason, 'not_configured');
  assert.equal(withoutLaya.results.every((row) => row.laya.applied === false), true);

  // The same run with laya answering must score identically.
  invalidateCoverageCache();
  const withLaya = await computeCoverage({
    questions: QUESTIONS,
    context: { organizationId: 'org_a' },
    deps: baseDeps({
      layaUrl: 'http://laya.test',
      layaRoute: async () => ['business'],
      memoryStore: makeStore({ calls }),
    }),
  });
  assert.deepEqual(
    withoutLaya.results.map((row) => row.score),
    withLaya.results.map((row) => row.score),
    'laya annotates ordering only — it must never move the percentage',
  );
  assert.equal(withLaya.layaApplied, true);
});

test('an unreachable laya fails open without failing the coverage request', async () => {
  const report = await computeCoverage({
    questions: QUESTIONS,
    context: { organizationId: 'org_a' },
    deps: baseDeps({
      layaUrl: 'http://laya.test',
      layaRoute: async () => { throw new Error('Laya inference timeout exceeded 1000ms SLA'); },
      memoryStore: makeStore(),
    }),
  });
  assert.equal(report.status, 'complete');
  assert.equal(report.layaApplied, false);
  assert.equal(report.layaReason, 'unreachable');
  assert.ok(report.results.find((row) => row.id === 'gq_org_01').score > 0, 'recall still scored this');
});

test('laya reorders matched scopes without inventing ones', async () => {
  const report = await computeCoverage({
    questions: QUESTIONS,
    context: { organizationId: 'org_a' },
    deps: baseDeps({
      layaUrl: 'http://laya.test',
      layaRoute: async (_prompt, candidates) => candidates.map((c) => c.id).reverse(),
      memoryStore: makeStore(),
    }),
  });
  const row = report.results.find((r) => r.id === 'gq_org_01');
  // recall matched business (0.92) then workspace (0.6); the fake laya reverses the
  // candidates it was handed, so the row must show exactly that reordering — and
  // only scopes recall already found, never one laya invented.
  assert.deepEqual(row.matchedScopes, ['workspace', 'business']);
  assert.equal(row.laya.applied, true);
  assert.equal(report.layaApplied, true);
  assert.equal(report.layaReason, null);
});

test('reports are cached per org and bank, bypassed by refresh and by invalidation', async () => {
  const calls = [];
  const deps = baseDeps({ memoryStore: makeStore({ calls }) });
  const first = await computeCoverage({ questions: QUESTIONS, context: { organizationId: 'org_a' }, deps });
  const second = await computeCoverage({ questions: QUESTIONS, context: { organizationId: 'org_a' }, deps });
  const forced = await computeCoverage({ questions: QUESTIONS, context: { organizationId: 'org_a' }, deps, refresh: true });

  assert.equal(first.cached, undefined);
  assert.equal(second.cached, true);
  assert.equal(forced.cached, undefined, 'refresh recomputes');
  assert.equal(calls.filter((c) => c === 'load').length, 2, 'only the two uncached runs read the store');
});

test('inactive questions are dropped and an oversized bank is capped', async () => {
  const calls = [];
  const questions = [
    ...QUESTIONS,
    { id: 'gq_org_02', category: 'organisation', subDimension: 'org_size', question: 'Tombstoned?', active: false },
    ...Array.from({ length: MAX_QUESTIONS_PER_RUN + 20 }, (_, i) => ({ id: `gq_pad_${i}`, category: 'person', subDimension: 'x', question: `Pad ${i}?`, active: true })),
  ];
  const report = await computeCoverage({ questions, context: { organizationId: 'org_a' }, deps: baseDeps({ memoryStore: makeStore({ calls }) }) });
  assert.equal(report.results.length, MAX_QUESTIONS_PER_RUN);
  assert.equal(report.results.some((row) => row.id === 'gq_org_02'), false);
  assert.equal(calls.filter((c) => c.startsWith('recall:')).length, MAX_QUESTIONS_PER_RUN);
});

test('questionIds narrows a pass so one category refresh never scans the whole bank', async () => {
  const calls = [];
  const report = await computeCoverage({
    questions: QUESTIONS,
    questionIds: ['gq_per_01', 'gq_unknown'],
    context: { organizationId: 'org_a' },
    deps: baseDeps({ memoryStore: makeStore({ calls }) }),
  });

  assert.deepEqual(report.results.map((row) => row.id), ['gq_per_01']);
  assert.equal(calls.filter((c) => c.startsWith('recall:')).length, 1, 'only the requested id is scored');
});

test('a bank edit clears only the editing organisation\'s cached report', async () => {
  const calls = [];
  const deps = baseDeps({ memoryStore: makeStore({ calls }) });
  await computeCoverage({ questions: QUESTIONS, context: { organizationId: 'org_a' }, deps });
  await computeCoverage({ questions: QUESTIONS, context: { organizationId: 'org_b' }, deps });

  assert.equal(invalidateCoverageCache('org_a'), 1, 'one key belongs to org_a');
  const rereadA = await computeCoverage({ questions: QUESTIONS, context: { organizationId: 'org_a' }, deps });
  const rereadB = await computeCoverage({ questions: QUESTIONS, context: { organizationId: 'org_b' }, deps });
  assert.equal(rereadA.cached, undefined, 'the editing org recomputes');
  assert.equal(rereadB.cached, true, 'another org keeps its report');
});

test('a run that outlives its budget returns 200-shaped partial results, not fake gaps', async () => {
  // A clock the fake recall advances, so the budget is exercised without sleeping:
  // each scored question "costs" 60ms against a 100ms budget, so the third is
  // skipped rather than reported as though memory had been searched and lost.
  let clock = 0;
  const slowStore = {
    isPostgresActive: () => false,
    async load() { return POOL; },
    async recallScored({ query }) {
      clock += 60;
      return HIT_PLAN[query] || [];
    },
  };

  const report = await computeCoverage({
    questions: QUESTIONS,
    context: { organizationId: 'org_partial' },
    deps: baseDeps({ memoryStore: slowStore, now: () => clock, runBudgetMs: 100 }),
  });

  assert.equal(report.status, 'partial');
  const skipped = report.results.filter((row) => row.status === 'not_evaluated');
  assert.equal(skipped.length, 1, 'exactly the questions past the deadline are skipped');
  assert.equal(skipped[0].score, null, 'a skipped row carries no score — 0 would read as a gap');
  assert.equal(report.overall.questionCount, 3, 'the bank size is still reported');
  assert.equal(report.overall.assessedCount, 2, 'the mean is taken over what was actually assessed');
  assert.ok(report.overall.score > 0, 'a partial run still reports the coverage it found');
});
