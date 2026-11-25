import type { MachineDeps, StepContext } from '../onboarding/machine.ts';
import { runOffboarding } from '../onboarding/machine.ts';
import type { OffboardingStepId } from '@fleet-local/shared';
import { loadOffboardStates, resetStaleOffboardStates, saveOffboardState } from '../db/onboarding.ts';
import { offboardExecutors } from './steps.ts';

// One teardown per organisation per process. The BFF runs as a single replica, so a
// Set is the whole mutex — and it is also what tells a stale 'running' row (the
// process died inside a step) from one this process is actively writing.
const activeOffboards = new Set<string>();

export function isOffboarding(orgId: string): boolean {
  return activeOffboards.has(orgId);
}

// Wire the generic machine to the offboarding table and the teardown executors.
// Resuming is this same call: durable state decides which steps actually run.
export async function runOrgOffboarding(
  ctx: Omit<StepContext<OffboardingStepId>, 'results'>,
  onEvent?: MachineDeps<OffboardingStepId>['onEvent'],
): Promise<Awaited<ReturnType<typeof runOffboarding>>> {
  if (activeOffboards.has(ctx.orgId)) {
    throw new Error('an offboarding run is already in progress for this organisation');
  }
  activeOffboards.add(ctx.orgId);
  try {
    // Safe now that this process owns the org: any 'running' row it finds was left
    // by a dead run, and a step parked as running would never be selected again.
    await resetStaleOffboardStates(ctx.orgId);
    return await runOffboarding({
      ctx,
      executors: offboardExecutors,
      loadStates: loadOffboardStates,
      saveState: saveOffboardState,
      onEvent,
    });
  } finally {
    activeOffboards.delete(ctx.orgId);
  }
}
