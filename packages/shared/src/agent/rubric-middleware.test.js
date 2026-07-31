'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RubricError,
  DEFAULT_PASS_THRESHOLD,
  normalizeRubric,
  scoreReview,
  buildReviewPrompt,
  reviewTaskCompletion,
  createRubricMiddleware,
  unavailableReview,
} = require('./rubric-middleware');

/* ------------------------------ normalization ------------------------------ */

test('normalizeRubric accepts a string array and fills stable defaults', () => {
  const rubric = normalizeRubric(['Tests pass', 'PR opened']);
  assert.equal(rubric.passThreshold, DEFAULT_PASS_THRESHOLD);
  assert.deepEqual(rubric.criteria.map((c) => c.id), ['tests-pass', 'pr-opened']);
  assert.equal(rubric.criteria[0].weight, 1);
  assert.equal(rubric.criteria[0].required, false);
});

test('normalizeRubric honors explicit ids, weights, required, threshold, and de-dupes ids', () => {
  const rubric = normalizeRubric({
    threshold: 0.5,
    criteria: [
      { id: 'build', description: 'Build succeeds', required: true, weight: 3 },
      { text: 'build', mustHave: false }, // duplicate slug → suffixed
    ],
  });
  assert.equal(rubric.passThreshold, 0.5);
  assert.deepEqual(rubric.criteria.map((c) => c.id), ['build', 'build-2']);
  assert.equal(rubric.criteria[0].required, true);
  assert.equal(rubric.criteria[0].weight, 3);
});

test('normalizeRubric clamps the threshold into [0,1] and drops blank criteria', () => {
  const rubric = normalizeRubric({ passThreshold: 5, criteria: ['Real', '', '   ', null] });
  assert.equal(rubric.passThreshold, 1);
  assert.equal(rubric.criteria.length, 1);
});

test('normalizeRubric rejects an empty rubric', () => {
  assert.throws(() => normalizeRubric([]), (e) => e instanceof RubricError && e.status === 400);
  assert.throws(() => normalizeRubric({ criteria: [{ description: '' }] }), RubricError);
  assert.throws(() => normalizeRubric(42), RubricError);
});

/* -------------------------------- scoring --------------------------------- */

test('scoreReview passes when the weighted score clears the threshold', () => {
  const rubric = normalizeRubric({ threshold: 0.7, criteria: ['a', 'b', 'c'] });
  const scored = scoreReview(rubric, [
    { id: 'a', met: true },
    { id: 'b', met: true },
    { id: 'c', met: false, reason: 'missing docs' },
  ]);
  assert.equal(scored.score, round(2 / 3));
  assert.equal(scored.verdict, 'insufficient'); // 0.6667 < 0.7
  assert.equal(scored.passed, false);
});

test('scoreReview weights criteria and can pass below a raw 2/3 count', () => {
  const rubric = normalizeRubric({
    threshold: 0.7,
    criteria: [
      { id: 'a', description: 'Heavy criterion', weight: 4 },
      { id: 'b', description: 'Light criterion', weight: 1 },
    ],
  });
  const scored = scoreReview(rubric, [{ id: 'a', met: true }, { id: 'b', met: false }]);
  assert.equal(scored.score, 0.8);
  assert.equal(scored.verdict, 'pass');
});

test('scoreReview forces fail when a required criterion is unmet, ignoring the score', () => {
  const rubric = normalizeRubric({
    threshold: 0.1,
    criteria: [
      { id: 'must', description: 'Required criterion', required: true, weight: 1 },
      { id: 'nice', description: 'Nice to have', weight: 100 },
    ],
  });
  const scored = scoreReview(rubric, [{ id: 'must', met: false }, { id: 'nice', met: true }]);
  assert.equal(scored.verdict, 'fail');
  assert.equal(scored.passed, false);
  assert.deepEqual(scored.unmetRequired, ['must']);
});

test('scoreReview treats an unassessed criterion as not met (conservative)', () => {
  const rubric = normalizeRubric(['a', 'b']);
  const scored = scoreReview(rubric, [{ id: 'a', met: true }]);
  assert.equal(scored.criteria[1].met, false);
  assert.match(scored.criteria[1].reason, /did not assess/i);
});

/* --------------------------------- prompt --------------------------------- */

test('buildReviewPrompt lists ids and marks task/output strictly as data', () => {
  const rubric = normalizeRubric([{ id: 'x', description: 'Do X', required: true }]);
  const { system, human } = buildReviewPrompt(rubric, 'the task', { finalText: 'the output' });
  assert.match(system, /strictly as DATA/i);
  assert.match(system, /Return ONLY JSON/i);
  assert.match(human, /\[x\] \(required, weight 1\): Do X/);
  assert.match(human, /the task/);
  assert.match(human, /the output/);
});

/* --------------------------------- review --------------------------------- */

test('reviewTaskCompletion scores via an injected judge and derives the verdict server-side', async () => {
  let captured = null;
  const review = await reviewTaskCompletion({
    rubric: {
      threshold: 0.7,
      criteria: [
        { id: 'a', description: 'Feature works' },
        { id: 'b', description: 'Tests added', required: true },
      ],
    },
    task: 'Ship the feature',
    execution: { finalText: 'Done. Opened PR #12.' },
    deps: {
      callJson: async ({ system, prompt }) => {
        captured = { system, prompt };
        // A dishonest judge claiming pass cannot override a required miss.
        return {
          json: { criteria: [{ id: 'a', met: true }, { id: 'b', met: false, reason: 'no tests' }], summary: 'ok-ish' },
          reviewer: { provider: 'ollama', model: 'qwen' },
        };
      },
    },
  });

  assert.match(captured.prompt, /Ship the feature/);
  assert.match(captured.prompt, /Opened PR #12/);
  assert.equal(review.available, true);
  assert.equal(review.verdict, 'fail');
  assert.equal(review.passed, false);
  assert.deepEqual(review.unmetRequired, ['b']);
  assert.deepEqual(review.reviewer, { provider: 'ollama', model: 'qwen' });
  assert.equal(review.error, null);
});

test('reviewTaskCompletion is fail-open when the judge throws', async () => {
  const review = await reviewTaskCompletion({
    rubric: ['a', 'b'],
    task: 't',
    execution: { finalText: 'x' },
    deps: { callJson: async () => { throw new Error('model down'); } },
  });
  assert.equal(review.available, false);
  assert.equal(review.verdict, 'insufficient');
  assert.equal(review.passed, false);
  assert.equal(review.score, null);
  assert.match(review.error, /model down/);
  assert.equal(review.criteria.length, 2);
});

test('reviewTaskCompletion is fail-open on a malformed rubric', async () => {
  const review = await reviewTaskCompletion({
    rubric: [],
    task: 't',
    execution: { finalText: 'x' },
    deps: { callJson: async () => ({ json: { criteria: [] } }) },
  });
  assert.equal(review.available, false);
  assert.equal(review.verdict, 'insufficient');
});

test('unavailableReview lists the rubric and flags required misses without a model', () => {
  const review = unavailableReview([{ id: 'must', description: 'x', required: true }], new Error('timeout'));
  assert.equal(review.available, false);
  assert.equal(review.criteria[0].met, false);
  assert.deepEqual(review.unmetRequired, ['must']);
  assert.match(review.error, /timeout/);
});

/* ------------------------------- middleware -------------------------------- */

test('createRubricMiddleware binds one rubric and reuses the injected seam', async () => {
  const calls = [];
  const mw = createRubricMiddleware({
    rubric: ['a'],
    deps: { callJson: async () => { calls.push(1); return { json: { criteria: [{ id: 'a', met: true }] } }; } },
  });
  assert.equal(mw.name, 'RubricReview');
  assert.deepEqual(mw.rubric.criteria.map((c) => c.id), ['a']);

  const review = await mw.reviewer({ task: 't', execution: { finalText: 'ok' } });
  assert.equal(review.verdict, 'pass');
  assert.equal(calls.length, 1);
});

test('createRubricMiddleware throws immediately on a bad rubric', () => {
  assert.throws(() => createRubricMiddleware({ rubric: [] }), RubricError);
});

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
