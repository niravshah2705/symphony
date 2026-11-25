import test from 'node:test';
import assert from 'node:assert/strict';
import { OFFBOARDING_STEPS, type OffboardingStepId, type StepState } from '@fleet-local/shared';
import { idempotencyKey, runOffboarding, type StepExecutor } from '../src/onboarding/machine.ts';

const ctx = {
  orgId: 'org-uuid',
  orgSlug: 'demo',
  orgName: 'Demo',
  userId: 'user-uuid',
  userEmail: 'nirav@example.com',
};

type States = Partial<Record<OffboardingStepId, StepState<OffboardingStepId>>>;

// Same harness as the onboarding machine test: fake executors over an in-memory
// state map, so what is under test is the DAG and the resume rules — not kubectl.
function harness(executors: Record<OffboardingStepId, StepExecutor<OffboardingStepId>>, initial: States = {}) {
  const states: States = structuredClone(initial);
  const calls: OffboardingStepId[] = [];
  const events: { step: OffboardingStepId; state: StepState<OffboardingStepId> }[] = [];
  const wrapped = Object.fromEntries(
    OFFBOARDING_STEPS.map((def) => [
      def.id,
      async (c: Parameters<StepExecutor<OffboardingStepId>>[0]) => {
        calls.push(def.id);
        return executors[def.id](c);
      },
    ]),
  ) as Record<OffboardingStepId, StepExecutor<OffboardingStepId>>;
  const deps = {
    ctx,
    executors: wrapped,
    loadStates: async () => structuredClone(states),
    saveState: async (_orgId: string, s: StepState<OffboardingStepId>) => {
      states[s.step] = structuredClone(s);
    },
    sleep: async () => {},
    onEvent: (e: { step: OffboardingStepId; state: StepState<OffboardingStepId> }) => events.push(e),
  };
  return { deps, states, calls, events };
}

const ok: Record<OffboardingStepId, StepExecutor<OffboardingStepId>> = Object.fromEntries(
  OFFBOARDING_STEPS.map((def) => [def.id, async () => ({ gone: def.id })]),
) as Record<OffboardingStepId, StepExecutor<OffboardingStepId>>;

const doneSeed = (step: OffboardingStepId): StepState<OffboardingStepId> => ({
  step,
  status: 'done',
  attempt: 1,
  idempotencyKey: idempotencyKey(ctx.orgId, step),
  result: { gone: step },
});

test('the teardown runs every step once and reports complete', async () => {
  const h = harness(ok);
  const { complete, states } = await runOffboarding(h.deps);
  assert.equal(complete, true);
  assert.equal(h.calls.length, OFFBOARDING_STEPS.length);
  for (const def of OFFBOARDING_STEPS) {
    assert.equal(states[def.id]?.status, 'done');
    assert.equal(states[def.id]?.idempotencyKey, idempotencyKey(ctx.orgId, def.id));
  }
  // release first: it is the only step with no dependency, and everything else
  // waits on the tenant's compute actually being gone.
  assert.equal(h.calls[0], 'release');
  assert.equal(h.calls.at(-1), 'access');
});

test('the removal sequence is what the UI promises: release, then detach, then the key', async () => {
  const h = harness(ok);
  await runOffboarding(h.deps);
  const at = (id: OffboardingStepId) => h.calls.indexOf(id);
  assert.ok(at('key') < at('namespace'), 'the virtual key must be deleted while its Secret still exists');
  assert.ok(at('workspace') < at('namespace'), 'the worker pool must drain before the namespace goes');
  assert.ok(at('namespace') < at('flexprice'), 'cancel the subscription only after the compute has stopped');
  assert.ok(at('substrate') < at('access'), 'membership is removed last so an unfinished teardown stays retryable');
});

test('a failing key blocks everything downstream of it and is not complete', async () => {
  const executors = {
    ...ok,
    key: async () => {
      throw new Error('litellm unreachable');
    },
  } as Record<OffboardingStepId, StepExecutor<OffboardingStepId>>;
  const h = harness(executors);
  const { complete, states } = await runOffboarding(h.deps);
  assert.equal(complete, false);
  assert.equal(states.key?.status, 'failed');
  assert.equal(states.key?.attempt, 3);
  assert.equal(states.release?.status, 'done');
  assert.equal(states.detach?.status, 'done');
  assert.equal(states.workspace?.status, 'done');
  // team/namespace/substrate/flexprice/access all sit behind the key.
  for (const id of ['team', 'namespace', 'substrate', 'flexprice', 'access'] as const) {
    assert.equal(states[id], undefined, `${id} must not run without the key step`);
  }
  // The org is therefore still offboarding rather than deleted-with-debt: the
  // route leaves the status alone unless the whole DAG completes.
  assert.ok(!h.calls.includes('access'));
});

test('resume re-enters at the failed step and never repeats a finished deletion', async () => {
  const initial: States = {
    release: doneSeed('release'),
    detach: doneSeed('detach'),
    workspace: doneSeed('workspace'),
    key: { ...doneSeed('key'), status: 'failed', attempt: 3, error: 'litellm unreachable', result: undefined },
  };
  const h = harness(ok, initial);
  const { complete, states } = await runOffboarding(h.deps);
  assert.equal(complete, true);
  assert.equal(states.key?.status, 'done');
  assert.equal(states.key?.attempt, 1, 'a retry gets a fresh attempt budget');
  for (const id of ['release', 'detach', 'workspace'] as const) {
    assert.ok(!h.calls.includes(id), `${id} already reported done — re-running a delete is how a name gets reused`);
  }
  assert.deepEqual(h.calls, ['key', 'team', 'namespace', 'substrate', 'flexprice', 'access']);
});

test('a finished teardown is a no-op', async () => {
  const initial: States = Object.fromEntries(OFFBOARDING_STEPS.map((def) => [def.id, doneSeed(def.id)]));
  const h = harness(ok, initial);
  const { complete } = await runOffboarding(h.deps);
  assert.equal(complete, true);
  assert.equal(h.calls.length, 0);
});

test('a step left running by a dead process parks the DAG until the state is reset', async () => {
  // Documents WHY runOrgOffboarding resets stale 'running' rows before starting:
  // runnableSteps will not hand out a step that looks in flight, so without that
  // reset a crash inside `key` would wedge the teardown forever.
  const initial: States = { release: doneSeed('release'), key: { ...doneSeed('key'), status: 'running' } };
  const h = harness(ok, initial);
  const { complete, states } = await runOffboarding(h.deps);
  assert.equal(states.key?.status, 'running');
  assert.equal(states.access, undefined);
  assert.equal(complete, false);
  assert.deepEqual(h.calls, ['detach', 'workspace']);
});

test('results of an earlier step reach the steps that need them', async () => {
  const executors = {
    ...ok,
    key: async () => ({ key: 'sk-virtual', alias: 'fleet:org-uuid:proj' }),
    team: async (c) => ({ backstoppedBy: c.results.key?.key ?? null }),
    access: async (c) => ({ membersRemoved: 1, via: c.results.team?.backstoppedBy ?? null }),
  } as Record<OffboardingStepId, StepExecutor<OffboardingStepId>>;
  const h = harness(executors);
  const { states } = await runOffboarding(h.deps);
  assert.equal(states.team?.result?.backstoppedBy, 'sk-virtual');
  assert.equal(states.access?.result?.via, 'sk-virtual');
});
