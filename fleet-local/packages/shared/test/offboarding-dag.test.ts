import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFBOARDING_STEPS,
  ONBOARDING_STEPS,
  nextRunnableOffboardSteps,
  type OffboardingStepId,
  type OnboardingStepId,
  type StepState,
} from '../src/index.ts';

const order = Object.fromEntries(OFFBOARDING_STEPS.map((s, i) => [s.id, i])) as Record<OffboardingStepId, number>;

// Which teardown step undoes which create step. `namespace` fans out to three
// teardown steps because one created scope holds three kinds of thing (the worker
// pool, the namespace itself, and the shared substrate policy naming it), and
// `workflow`/`agent` collapse into one because the helm release owns both.
const reverses: Record<OnboardingStepId, OffboardingStepId[]> = {
  org: ['access'],
  project: ['team'],
  workflow: ['release'],
  agent: ['release'],
  attach: ['detach'],
  key: ['key'],
  namespace: ['workspace', 'namespace', 'substrate'],
  flexprice: ['flexprice'],
  limits: ['flexprice'],
};

test('teardown step ids are unique and every dependency is declared', () => {
  const ids = OFFBOARDING_STEPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const step of OFFBOARDING_STEPS) {
    for (const dep of step.deps) {
      assert.ok(ids.includes(dep), `${step.id} depends on undeclared ${dep}`);
      assert.notEqual(dep, step.id, `${step.id} depends on itself`);
      // A dependency must be declared earlier in the list: the machine walks the
      // array in order, so a later-declared dependency is dead configuration.
      assert.ok(order[dep] < order[step.id], `${step.id} depends on the later-declared ${dep}`);
    }
  }
});

test('every create step is reversed, and no teardown step undoes nothing', () => {
  const covered = new Set(Object.values(reverses).flat());
  assert.deepEqual(
    [...covered].sort(),
    OFFBOARDING_STEPS.map((s) => s.id).sort(),
    'the teardown list and the reverse map disagree',
  );
  // The # column in the wizard points at the create step being undone, so each
  // teardown step must carry the diagram number of one of the steps it reverses
  // (several can reverse one, so this is a membership check, not an equality map).
  const diagramOf = Object.fromEntries(ONBOARDING_STEPS.map((s) => [s.id, s.diagram]));
  const creators = (id: OffboardingStepId) =>
    (Object.keys(reverses) as OnboardingStepId[]).filter((create) => reverses[create].includes(id));
  for (const step of OFFBOARDING_STEPS) {
    assert.ok(
      creators(step.id).some((create) => diagramOf[create] === step.diagram),
      `${step.id} carries #${step.diagram}, which reverses nothing it is mapped to`,
    );
  }
});

// These are not stylistic: each pair prevents a named hazard. An edit that
// reorders the DAG trips exactly one of them.
test('the order holds the teardown hazards', () => {
  const before = (a: OffboardingStepId, b: OffboardingStepId, why: string) =>
    assert.ok(order[a] < order[b], `${a} must precede ${b}: ${why}`);

  before('key', 'namespace', 'the raw LiteLLM virtual key exists only in that Secret — delete the namespace first and the key is orphaned but still spend-capable');
  before('workspace', 'namespace', 'namespace deletion alone can leave atelet-managed gVisor sandboxes running');
  before('release', 'namespace', 'every custom resource the tenant release renders lives in that namespace');
  before('release', 'detach', 'a project pointer must outlive its agent by one step: if the release deletion fails the agent is still reachable, if the pointer write fails nothing is stranded');
  before('key', 'team', 'the team delete is the backstop for a key this process could not name');
  before('namespace', 'flexprice', 'cancelling the subscription invoices the open usage period, so the compute must already be stopped');
  before('substrate', 'access', 'membership is removed last: an incomplete teardown must stay visible to the owner who has to retry it');
  before('flexprice', 'access', 'the final invoice must be reachable by the account it is issued to');
});

const done = (step: OffboardingStepId): StepState<OffboardingStepId> => ({
  step,
  status: 'done',
  attempt: 1,
  idempotencyKey: `k:${step}`,
});

test('the teardown DAG selects its steps', () => {
  assert.deepEqual(nextRunnableOffboardSteps({}), ['release']);

  const released = { release: done('release') };
  assert.deepEqual(
    nextRunnableOffboardSteps(released).sort(),
    ['detach', 'key', 'workspace'],
    'release fans out to three independent steps',
  );

  // A step this process is running must not be handed out again, and its
  // dependents stay blocked until it is done.
  assert.deepEqual(nextRunnableOffboardSteps({ release: { ...done('release'), status: 'running' } }), []);
  assert.deepEqual(nextRunnableOffboardSteps({ release: done('release'), key: done('key') }).sort(), [
    'detach',
    'team',
    'workspace',
  ]);

  const allDone = Object.fromEntries(OFFBOARDING_STEPS.map((s) => [s.id, done(s.id)]));
  assert.deepEqual(nextRunnableOffboardSteps(allDone), []);
});
