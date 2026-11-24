import type { OnboardingStepId } from '@fleet-local/shared';
import { loadStates, saveState } from '../db/onboarding.ts';
import { runOnboarding, type MachineDeps, type StepContext } from './machine.ts';
import { executors } from './steps/index.ts';

// Wire the generic machine to durable DB state and the concrete step executors.
export function runOrgOnboarding(
  ctx: Omit<StepContext, 'results'>,
  onEvent?: MachineDeps<OnboardingStepId>['onEvent'],
): ReturnType<typeof runOnboarding> {
  return runOnboarding({ ctx, executors, loadStates, saveState, onEvent });
}