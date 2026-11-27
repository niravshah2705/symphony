import test from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLE_STEPS, nextRunnableBundleSteps, type BundleStepId, type StepState } from '../src/index.ts';

const ids = BUNDLE_STEPS.map((s) => s.id);
const order = Object.fromEntries(BUNDLE_STEPS.map((s, i) => [s.id, i])) as Record<BundleStepId, number>;

test('bundle step ids are unique and every dependency is declared earlier', () => {
  assert.equal(new Set(ids).size, ids.length);
  for (const step of BUNDLE_STEPS) {
    for (const dep of step.deps) {
      assert.ok(ids.includes(dep), `${step.id} depends on undeclared ${dep}`);
      assert.notEqual(dep, step.id, `${step.id} depends on itself`);
      assert.ok(order[dep] < order[step.id], `${step.id} depends on the later-declared ${dep}`);
    }
  }
});

// A bundle build spends real Cloud Build seconds, so the ordering that prevents
// paying for work that cannot be used is the point of this DAG.
test('nothing is submitted before the Dockerfile is known to be buildable', () => {
  const before = (a: BundleStepId, b: BundleStepId, why: string) =>
    assert.ok(order[a] < order[b], `${a} must precede ${b}: ${why}`);

  before('plan', 'base', 'the key is derived from the selection, so it exists before anything is resolved for it');
  before('base', 'generate', 'the FROM line names a digest, and an unpinned base tag would make the key lie about its contents');
  before('generate', 'submit', 'a refused requirement line must cost nothing; submitting first is a build paid for and thrown away');
  before('submit', 'poll', 'there is nothing to wait for until a build id exists');
  before('poll', 'publish', 'the digest only becomes trustworthy once the build reports SUCCESS');
  before('publish', 'mirror', 'the mirror copies a published digest; copying an assumed one is how a Harness ends up pointing at a manifest that is not there');
  before('mirror', 'apply', 'the rendered Harness must name the ref the cluster can actually pull');
  before('apply', 'verify', 'the pull probe proves the object that was just written, so it has to run after it');
});

const done = (step: BundleStepId): StepState<BundleStepId> => ({
  step,
  status: 'done',
  attempt: 1,
  idempotencyKey: `k:${step}`,
});

test('the bundle DAG is a single chain that resumes where it stopped', () => {
  assert.deepEqual(nextRunnableBundleSteps({}), ['plan']);
  for (const [i, step] of BUNDLE_STEPS.entries()) {
    const states = Object.fromEntries(BUNDLE_STEPS.slice(0, i).map((s) => [s.id, done(s.id)]));
    assert.deepEqual(nextRunnableBundleSteps(states), [step.id], `after ${i} done steps, ${step.id} is next`);
  }
  const allDone = Object.fromEntries(BUNDLE_STEPS.map((s) => [s.id, done(s.id)]));
  assert.deepEqual(nextRunnableBundleSteps(allDone), []);

  // A step in flight is not handed out again, and a failure stops the chain:
  // nothing downstream of a failed poll is runnable, because every later step
  // reads the digest that step was meant to produce.
  assert.deepEqual(nextRunnableBundleSteps({ plan: done('plan'), base: { ...done('base'), status: 'running' } }), []);
  assert.deepEqual(
    nextRunnableBundleSteps({ plan: done('plan'), base: { ...done('base'), status: 'failed', error: 'boom' } }),
    ['base'],
    'a failed step is retryable, and it is the only thing the chain can do',
  );
});
