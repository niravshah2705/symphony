import {
  ONBOARDING_STEPS,
  nextRunnableSteps,
  type OnboardingStepId,
  type StepState,
} from '@fleet-local/shared';

export interface StepContext {
  orgId: string;
  orgSlug: string;
  orgName: string;
  userId: string;
  userEmail: string;
  // Results of already-completed steps, keyed by step id (e.g. project uuid,
  // virtual key, namespace). Executors read their dependencies from here.
  results: Partial<Record<OnboardingStepId, Record<string, unknown>>>;
}

export type StepExecutor = (ctx: StepContext) => Promise<Record<string, unknown>>;

export interface MachineDeps {
  ctx: Omit<StepContext, 'results'>;
  executors: Record<OnboardingStepId, StepExecutor>;
  loadStates: (orgId: string) => Promise<Partial<Record<OnboardingStepId, StepState>>>;
  saveState: (orgId: string, state: StepState) => Promise<void>;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (event: { step: OnboardingStepId; state: StepState }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function idempotencyKey(orgId: string, step: OnboardingStepId): string {
  return `${orgId}:${step}`;
}

// Run the onboarding DAG to completion (or until a step fails and blocks its
// dependents). Resumable: re-entering loads durable state and only runs steps
// that are not already done. Every executor is find-or-create, so re-running a
// done step is skipped and a retried step never duplicates external resources.
export async function runOnboarding(
  deps: MachineDeps,
): Promise<{ states: Partial<Record<OnboardingStepId, StepState>>; complete: boolean }> {
  const maxAttempts = deps.maxAttempts ?? 3;
  const sleep = deps.sleep ?? defaultSleep;
  const states = await deps.loadStates(deps.ctx.orgId);
  const results: Partial<Record<OnboardingStepId, Record<string, unknown>>> = {};
  for (const def of ONBOARDING_STEPS) {
    const s = states[def.id];
    if (s?.status === 'done' && s.result) results[def.id] = s.result;
  }

  const emit = (step: OnboardingStepId, state: StepState) => {
    states[step] = state;
    deps.onEvent?.({ step, state });
  };

  // Steps that exhausted their attempts in THIS run are terminal-failed here;
  // they stay 'failed' in durable state so a later resume retries them, but they
  // must not be re-selected within this run (nextRunnableSteps treats a failed
  // step as runnable, which would otherwise spin the outer loop forever).
  const exhausted = new Set<OnboardingStepId>();

  for (;;) {
    const runnable = nextRunnableSteps(states).filter((s) => !exhausted.has(s));
    if (runnable.length === 0) break;

    for (const step of runnable) {
      let lastError = '';
      let succeeded = false;

      // Each run gives a non-done step a fresh attempt budget, so resuming after
      // a failure (the wizard's retry) actually retries it instead of carrying
      // the exhausted count forward and skipping straight to blocked.
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const running: StepState = {
          step,
          status: 'running',
          attempt,
          idempotencyKey: idempotencyKey(deps.ctx.orgId, step),
        };
        await deps.saveState(deps.ctx.orgId, running);
        emit(step, running);
        try {
          const ctx: StepContext = { ...deps.ctx, results };
          const result = await deps.executors[step](ctx);
          results[step] = result;
          const done: StepState = { ...running, status: 'done', result };
          await deps.saveState(deps.ctx.orgId, done);
          emit(step, done);
          succeeded = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          const failed: StepState = { ...running, status: 'failed', error: lastError };
          await deps.saveState(deps.ctx.orgId, failed);
          emit(step, failed);
          if (attempt < maxAttempts) await sleep(2 ** attempt * 250);
        }
      }

      // A failed step blocks only its own dependents (nextRunnableSteps won't
      // select them while the dep is not done). Independent runnable steps in
      // this pass still proceed.
      if (!succeeded) exhausted.add(step);
    }
  }

  const complete = ONBOARDING_STEPS.every((def) => states[def.id]?.status === 'done');
  return { states, complete };
}