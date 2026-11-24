import test from 'node:test';
import assert from 'node:assert/strict';
import { runOnboarding, idempotencyKey, type StepExecutor } from '../src/onboarding/machine.ts';
import { ONBOARDING_STEPS, type OnboardingStepId, type StepState } from '@fleet-local/shared';

const ctx = {
  orgId: 'org-uuid',
  orgSlug: 'demo',
  orgName: 'Demo',
  userId: 'user-uuid',
  userEmail: 'nirav@example.com',
};

type States = Partial<Record<OnboardingStepId, StepState>>;

function harness(executors: Record<OnboardingStepId, StepExecutor>, initial: States = {}) {
  const states: States = structuredClone(initial);
  const calls: OnboardingStepId[] = [];
  const events: { step: OnboardingStepId; state: StepState }[] = [];
  const wrapped = Object.fromEntries(
    ONBOARDING_STEPS.map((def) => [
      def.id,
      async (c: Parameters<StepExecutor>[0]) => {
        calls.push(def.id);
        return executors[def.id](c);
      },
    ]),
  ) as Record<OnboardingStepId, StepExecutor>;
  const deps = {
    ctx,
    executors: wrapped,
    loadStates: async () => structuredClone(states),
    saveState: async (_orgId: string, s: StepState) => {
      states[s.step] = structuredClone(s);
    },
    sleep: async () => {},
    onEvent: (e: { step: OnboardingStepId; state: StepState }) => events.push(e),
  };
  return { deps, states, calls, events };
}

const ok: Record<OnboardingStepId, StepExecutor> = Object.fromEntries(
  ONBOARDING_STEPS.map((def) => [def.id, async () => ({ done: def.id })]),
) as Record<OnboardingStepId, StepExecutor>;

test('happy path runs every step once and reports complete', async () => {
  const h = harness(ok);
  const { complete, states } = await runOnboarding(h.deps);
  assert.equal(complete, true);
  assert.equal(h.calls.length, ONBOARDING_STEPS.length);
  for (const def of ONBOARDING_STEPS) {
    assert.equal(states[def.id]?.status, 'done');
    assert.equal(states[def.id]?.idempotencyKey, idempotencyKey(ctx.orgId, def.id));
  }
});

test('dependency results are threaded into later executors', async () => {
  const executors = {
    ...ok,
    project: async () => ({ projectId: 'proj-uuid', slug: 'default' }),
    key: async (c) => ({ projectId: c.results.project?.projectId }),
  } as Record<OnboardingStepId, StepExecutor>;
  const h = harness(executors);
  const { states } = await runOnboarding(h.deps);
  assert.equal(states.key?.result?.projectId, 'proj-uuid');
});

test('re-running with all steps done calls no executors (idempotent resume)', async () => {
  const initial: States = Object.fromEntries(
    ONBOARDING_STEPS.map((def) => [
      def.id,
      { step: def.id, status: 'done', attempt: 1, idempotencyKey: 'k', result: { done: def.id } },
    ]),
  );
  const h = harness(ok, initial);
  const { complete } = await runOnboarding(h.deps);
  assert.equal(complete, true);
  assert.equal(h.calls.length, 0);
});

test('a step that fails twice then succeeds retries to attempt 3', async () => {
  let attempts = 0;
  const executors = {
    ...ok,
    flexprice: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient');
      return { walletId: 'w' };
    },
  } as Record<OnboardingStepId, StepExecutor>;
  const h = harness(executors);
  const { complete, states } = await runOnboarding(h.deps);
  assert.equal(complete, true);
  assert.equal(attempts, 3);
  assert.equal(states.flexprice?.attempt, 3);
  assert.equal(states.flexprice?.status, 'done');
});

test('a permanently failing step blocks its dependents and is not complete', async () => {
  const executors = {
    ...ok,
    org: async () => {
      throw new Error('boom');
    },
  } as Record<OnboardingStepId, StepExecutor>;
  const h = harness(executors);
  const { complete, states } = await runOnboarding(h.deps);
  assert.equal(complete, false);
  assert.equal(states.org?.status, 'failed');
  assert.equal(states.org?.attempt, 3);
  // Nothing downstream of org ran.
  assert.deepEqual(h.calls, ['org', 'org', 'org']);
  assert.equal(states.namespace, undefined);
  assert.equal(states.project, undefined);
});

test('resume re-enters at the first non-done step', async () => {
  const initial: States = {
    org: { step: 'org', status: 'done', attempt: 1, idempotencyKey: 'k', result: { orgId: 'org-uuid' } },
    project: { step: 'project', status: 'done', attempt: 1, idempotencyKey: 'k', result: { projectId: 'proj-uuid' } },
  };
  const h = harness(ok, initial);
  const { complete } = await runOnboarding(h.deps);
  assert.equal(complete, true);
  assert.ok(!h.calls.includes('org'));
  assert.ok(!h.calls.includes('project'));
  assert.ok(h.calls.includes('key'));
  assert.ok(h.calls.includes('limits'));
});

test('resume retries a previously failed step with a fresh attempt budget', async () => {
  const initial: States = {
    org: { step: 'org', status: 'failed', attempt: 3, idempotencyKey: 'k', error: 'boom' },
  };
  const h = harness(ok, initial);
  const { complete, states } = await runOnboarding(h.deps);
  assert.equal(complete, true);
  assert.ok(h.calls.includes('org'));
  assert.equal(states.org?.status, 'done');
  assert.equal(states.org?.attempt, 1);
});

test('an independent step still runs when a sibling fails', async () => {
  const executors = {
    ...ok,
    namespace: async () => {
      throw new Error('ns boom');
    },
  } as Record<OnboardingStepId, StepExecutor>;
  const h = harness(executors);
  const { complete, states } = await runOnboarding(h.deps);
  assert.equal(complete, false);
  assert.equal(states.namespace?.status, 'failed');
  // project/flexprice/key/limits do not depend on namespace and still complete.
  assert.equal(states.project?.status, 'done');
  assert.equal(states.flexprice?.status, 'done');
  assert.equal(states.key?.status, 'done');
  assert.equal(states.limits?.status, 'done');
  // workflow/agent/attach depend on namespace and stay blocked.
  assert.equal(states.workflow, undefined);
  assert.equal(states.agent, undefined);
  assert.equal(states.attach, undefined);
});