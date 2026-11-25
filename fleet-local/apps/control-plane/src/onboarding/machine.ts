import {
  OFFBOARDING_STEPS,
  ONBOARDING_STEPS,
  runnableSteps,
  type OffboardingStepId,
  type OnboardingStepId,
  type StepDef,
  type StepState,
} from '@fleet-local/shared';

export interface StepContext<S extends string = OnboardingStepId> {
  orgId: string;
  orgSlug: string;
  orgName: string;
  userId: string;
  userEmail: string;
  // Results of already-completed steps, keyed by step id (e.g. project uuid,
  // virtual key, namespace). Executors read their dependencies from here.
  results: Partial<Record<S, Record<string, unknown>>>;
}

export type StepExecutor<S extends string = OnboardingStepId> = (ctx: StepContext<S>) => Promise<Record<string, unknown>>;

export interface MachineDeps<S extends string> {
  ctx: Omit<StepContext<S>, 'results'>;
  executors: Record<S, StepExecutor<S>>;
  loadStates: (orgId: string) => Promise<Partial<Record<S, StepState<S>>>>;
  saveState: (orgId: string, state: StepState<S>) => Promise<void>;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (event: { step: S; state: StepState<S> }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function idempotencyKey(orgId: string, step: string): string {
  return `${orgId}:${step}`;
}

// Run a step DAG to completion (or until a step fails and blocks its dependents).
// Resumable: re-entering loads durable state and only runs steps that are not
// already done. Every executor is find-or-create or gone-is-fine, so re-running a
// done step is skipped and a retry never duplicates — or fails on the absence of —
// an external resource.
export async function runMachine<S extends string>(
  steps: readonly StepDef<S>[],
  deps: MachineDeps<S>,
): Promise<{ states: Partial<Record<S, StepState<S>>>; complete: boolean }> {
  const maxAttempts = deps.maxAttempts ?? 3;
  const sleep = deps.sleep ?? defaultSleep;
  const states = await deps.loadStates(deps.ctx.orgId);
  const results: Partial<Record<S, Record<string, unknown>>> = {};
  for (const def of steps) {
    const s = states[def.id];
    if (s?.status === 'done' && s.result) results[def.id] = s.result;
  }

  const emit = (step: S, state: StepState<S>) => {
    states[step] = state;
    deps.onEvent?.({ step, state });
  };

  // Steps that exhausted their attempts in THIS run are terminal-failed here;
  // they stay 'failed' in durable state so a later resume retries them, but they
  // must not be re-selected within this run (runnableSteps treats a failed step as
  // runnable, which would otherwise spin the outer loop forever).
  const exhausted = new Set<S>();

  for (;;) {
    const runnable = runnableSteps(steps, states).filter((s) => !exhausted.has(s));
    if (runnable.length === 0) break;

    for (const step of runnable) {
      let lastError = '';
      let succeeded = false;

      // Each run gives a non-done step a fresh attempt budget, so resuming after
      // a failure (the wizard's retry) actually retries it instead of carrying
      // the exhausted count forward and skipping straight to blocked.
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const running: StepState<S> = {
          step,
          status: 'running',
          attempt,
          idempotencyKey: idempotencyKey(deps.ctx.orgId, step),
        };
        await deps.saveState(deps.ctx.orgId, running);
        emit(step, running);
        try {
          const ctx: StepContext<S> = { ...deps.ctx, results };
          const result = await deps.executors[step](ctx);
          results[step] = result;
          const done: StepState<S> = { ...running, status: 'done', result };
          await deps.saveState(deps.ctx.orgId, done);
          emit(step, done);
          succeeded = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          const failed: StepState<S> = { ...running, status: 'failed', error: lastError };
          await deps.saveState(deps.ctx.orgId, failed);
          emit(step, failed);
          if (attempt < maxAttempts) await sleep(2 ** attempt * 250);
        }
      }

      // A failed step blocks only its own dependents (runnableSteps won't
      // select them while the dep is not done). Independent runnable steps in
      // this pass still proceed.
      if (!succeeded) exhausted.add(step);
    }
  }

  const complete = steps.every((def) => states[def.id]?.status === 'done');
  return { states, complete };
}

export function runOnboarding(
  deps: MachineDeps<OnboardingStepId>,
): ReturnType<typeof runMachine<OnboardingStepId>> {
  return runMachine(ONBOARDING_STEPS, deps);
}

export function runOffboarding(
  deps: MachineDeps<OffboardingStepId>,
): ReturnType<typeof runMachine<OffboardingStepId>> {
  return runMachine(OFFBOARDING_STEPS, deps);
}
