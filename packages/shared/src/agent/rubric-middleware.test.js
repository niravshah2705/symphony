'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RubricError,
  RESULT,
  DEFAULT_MAX_ITERATIONS,
  normalizeRubric,
  scoreCriteria,
  buildGraderPrompt,
  buildRevisionPrompt,
  gradeOnce,
  runRubric,
  createRubricMiddleware,
  failedReview,
} = require('./rubric-middleware');

/* ------------------------------ normalization ------------------------------ */

test('normalizeRubric parses a newline checklist and strips bullets', () => {
  const rubric = normalizeRubric('- The poem has three lines\n- Theme is spring\n');
  assert.deepEqual(rubric.criteria.map((c) => c.name), ['The poem has three lines', 'Theme is spring']);
});

test('normalizeRubric accepts arrays of strings or objects and de-dupes', () => {
  const rubric = normalizeRubric(['Tests pass', { description: 'PR opened' }, 'tests pass']);
  assert.deepEqual(rubric.criteria.map((c) => c.name), ['Tests pass', 'PR opened']);
});

test('normalizeRubric accepts an object with a rubric/criteria field', () => {
  assert.equal(normalizeRubric({ rubric: '- a\n- b' }).criteria.length, 2);
  assert.equal(normalizeRubric({ criteria: ['a', 'b', 'c'] }).criteria.length, 3);
});

test('normalizeRubric rejects an empty or non-checklist rubric', () => {
  assert.throws(() => normalizeRubric('   \n  '), (e) => e instanceof RubricError && e.status === 400);
  assert.throws(() => normalizeRubric([]), RubricError);
  assert.throws(() => normalizeRubric(42), RubricError);
});

/* -------------------------------- scoring --------------------------------- */

test('scoreCriteria is satisfied only when every criterion passes (all-or-nothing)', () => {
  const rubric = normalizeRubric(['a', 'b']);
  const all = scoreCriteria(rubric, [{ name: 'a', passed: true }, { name: 'b', passed: true }]);
  assert.equal(all.result, RESULT.SATISFIED);
  const some = scoreCriteria(rubric, [{ name: 'a', passed: true }, { name: 'b', passed: false, gap: 'missing' }]);
  assert.equal(some.result, RESULT.NEEDS_REVISION);
  assert.equal(some.criteria[1].gap, 'missing');
});

test('scoreCriteria matches by verbatim name regardless of order', () => {
  const rubric = normalizeRubric(['first', 'second']);
  const scored = scoreCriteria(rubric, [{ name: 'second', passed: false, gap: 'no' }, { name: 'first', passed: true }]);
  assert.equal(scored.criteria[0].passed, true);
  assert.equal(scored.criteria[1].passed, false);
});

test('scoreCriteria treats a criterion the grader omitted as not passed', () => {
  const rubric = normalizeRubric(['a', 'b']);
  const scored = scoreCriteria(rubric, [{ name: 'a', passed: true }]);
  assert.equal(scored.criteria[1].passed, false);
  assert.match(scored.criteria[1].gap, /not demonstrated/i);
  assert.equal(scored.result, RESULT.NEEDS_REVISION);
});

test('a passed criterion never carries a gap even if the grader supplied one', () => {
  const rubric = normalizeRubric(['a']);
  const scored = scoreCriteria(rubric, [{ name: 'a', passed: true, gap: 'noise' }]);
  assert.equal(scored.criteria[0].gap, '');
});

/* --------------------------------- prompts -------------------------------- */

test('buildGraderPrompt lists the checklist and demands verbatim names', () => {
  const rubric = normalizeRubric(['Do X', 'Do Y']);
  const prompt = buildGraderPrompt(rubric, 'the task', { finalText: 'the output' });
  assert.match(prompt, /- Do X\n- Do Y/);
  assert.match(prompt, /the task/);
  assert.match(prompt, /the output/);
  assert.match(prompt, /verbatim/i);
});

test('buildRevisionPrompt appends only the unmet gaps and bumps the iteration', () => {
  const evaluation = {
    iteration: 1,
    criteria: [
      { name: 'a', passed: true, gap: '' },
      { name: 'b', passed: false, gap: 'add tests' },
    ],
  };
  const prompt = buildRevisionPrompt('BASE TASK', evaluation);
  assert.match(prompt, /^BASE TASK/);
  assert.match(prompt, /rubric_revision iteration="2"/);
  assert.match(prompt, /- b — add tests/);
  assert.doesNotMatch(prompt, /- a /);
});

/* --------------------------------- gradeOnce ------------------------------- */

test('gradeOnce returns a RubricEvaluation from an injected grader', async () => {
  const rubric = normalizeRubric(['a', 'b']);
  const evaluation = await gradeOnce({
    rubric,
    task: 't',
    output: { finalText: 'work' },
    iteration: 1,
    callJson: async () => ({ json: { criteria: [{ name: 'a', passed: true }, { name: 'b', passed: false, gap: 'x' }], explanation: 'why' }, grader: { provider: 'ollama', model: 'q' } }),
  });
  assert.equal(evaluation.iteration, 1);
  assert.equal(evaluation.result, RESULT.NEEDS_REVISION);
  assert.equal(evaluation.explanation, 'why');
  assert.equal(typeof evaluation.gradingRunId, 'string');
  assert.deepEqual(evaluation.grader, { provider: 'ollama', model: 'q' });
});

test('gradeOnce reports grader_error (fail-open) when the grader throws', async () => {
  const rubric = normalizeRubric(['a']);
  const evaluation = await gradeOnce({
    rubric, task: 't', output: 'o', iteration: 1,
    callJson: async () => { throw new Error('model down'); },
  });
  assert.equal(evaluation.result, RESULT.GRADER_ERROR);
  assert.equal(evaluation.criteria[0].passed, false);
  assert.match(evaluation.error, /model down/);
});

/* ---------------------------------- loop ---------------------------------- */

test('runRubric terminates immediately when the first grade is satisfied', async () => {
  const calls = [];
  const review = await runRubric({
    rubric: ['a'],
    task: 't',
    output: { finalText: 'done' },
    runAgent: async () => { calls.push('rerun'); return { finalText: 'again' }; },
    deps: { callJson: async () => ({ json: { criteria: [{ name: 'a', passed: true }] } }) },
  });
  assert.equal(review.result, RESULT.SATISFIED);
  assert.equal(review.satisfied, true);
  assert.equal(review.iterations, 1);
  assert.equal(calls.length, 0); // never re-ran the agent
});

test('runRubric re-prompts the agent with gaps until satisfied', async () => {
  const prompts = [];
  let round = 0;
  const review = await runRubric({
    rubric: ['tests pass'],
    task: 'Ship it',
    basePrompt: 'BASE',
    output: { finalText: 'v1' },
    maxIterations: 3,
    runAgent: async (prompt) => { prompts.push(prompt); return { finalText: `v${prompts.length + 1}`, usage: null }; },
    deps: {
      callJson: async () => {
        round += 1;
        // Fail the first grade, pass the second (after one revision).
        return { json: { criteria: [{ name: 'tests pass', passed: round >= 2, gap: 'no tests' }] } };
      },
    },
  });
  assert.equal(review.result, RESULT.SATISFIED);
  assert.equal(review.iterations, 2);
  assert.equal(prompts.length, 1); // exactly one re-run
  assert.match(prompts[0], /BASE/);
  assert.match(prompts[0], /tests pass — no tests/);
  assert.deepEqual(review.finalResult, { finalText: 'v2', usage: null });
});

test('runRubric hits max_iterations_reached when criteria keep failing', async () => {
  let reruns = 0;
  const review = await runRubric({
    rubric: ['a'],
    task: 't',
    output: { finalText: 'v1' },
    maxIterations: 2,
    runAgent: async () => { reruns += 1; return { finalText: 'again' }; },
    deps: { callJson: async () => ({ json: { criteria: [{ name: 'a', passed: false, gap: 'nope' }] } }) },
  });
  assert.equal(review.result, RESULT.MAX_ITERATIONS_REACHED);
  assert.equal(review.satisfied, false);
  assert.equal(review.iterations, 2);
  assert.equal(reruns, 1); // 2 grades, 1 re-run between them
  assert.deepEqual(review.unsatisfied, ['a']);
});

test('runRubric cannot re-run without a runAgent, so it stops at needs_revision', async () => {
  const review = await runRubric({
    rubric: ['a'],
    task: 't',
    output: 'v1',
    maxIterations: 5,
    deps: { callJson: async () => ({ json: { criteria: [{ name: 'a', passed: false }] } }) },
  });
  assert.equal(review.result, RESULT.NEEDS_REVISION);
  assert.equal(review.iterations, 1);
});

test('runRubric is fail-open on a bad rubric (failed) and a grader outage (grader_error)', async () => {
  const bad = await runRubric({ rubric: [], task: 't', output: 'o' });
  assert.equal(bad.result, RESULT.FAILED);
  assert.equal(bad.iterations, 0);

  const down = await runRubric({
    rubric: ['a'], task: 't', output: 'o',
    deps: { callJson: async () => { throw new Error('boom'); } },
  });
  assert.equal(down.result, RESULT.GRADER_ERROR);
  assert.match(down.error, /boom/);
});

test('runRubric fires onEvaluation once per grading iteration', async () => {
  const seen = [];
  await runRubric({
    rubric: ['a'],
    task: 't',
    output: { finalText: 'v1' },
    maxIterations: 2,
    onEvaluation: (ev) => seen.push(ev.iteration),
    runAgent: async () => ({ finalText: 'v2' }),
    deps: { callJson: async () => ({ json: { criteria: [{ name: 'a', passed: false }] } }) },
  });
  assert.deepEqual(seen, [1, 2]);
});

/* ------------------------------- middleware -------------------------------- */

test('createRubricMiddleware exposes the upstream name and binds a rubric', async () => {
  const mw = createRubricMiddleware({
    rubric: '- a\n- b',
    maxIterations: 4,
    deps: { callJson: async () => ({ json: { criteria: [{ name: 'a', passed: true }, { name: 'b', passed: true }] } }) },
  });
  assert.equal(mw.name, 'RubricMiddleware');
  assert.equal(mw.maxIterations, 4);
  assert.deepEqual(mw.rubric.criteria.map((c) => c.name), ['a', 'b']);

  const review = await mw.run({ task: 't', output: { finalText: 'ok' } });
  assert.equal(review.result, RESULT.SATISFIED);
});

test('createRubricMiddleware throws immediately on a bad bound rubric', () => {
  assert.throws(() => createRubricMiddleware({ rubric: [] }), RubricError);
});

test('failedReview lists the rubric names and never throws', () => {
  const review = failedReview(['a', 'b'], new Error('timeout'));
  assert.equal(review.result, RESULT.FAILED);
  assert.deepEqual(review.unsatisfied, ['a', 'b']);
  assert.match(review.error, /timeout/);
  assert.equal(DEFAULT_MAX_ITERATIONS, 3);
});
