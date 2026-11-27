import { BUNDLE_STEPS, type BundleStepId } from '@fleet-local/shared';
import { loadBundleStates, resetStaleBundleStates, saveBundleState } from '../db/bundle.ts';
import { runMachine, type MachineDeps, type StepContext } from '../onboarding/machine.ts';
import { bundleExecutors, type BundleSelection } from './steps.ts';

// One build per (org, target) per process. The BFF runs as a single replica, so a
// Set is the whole mutex — and it is also what distinguishes a stale 'running' row
// (the process died inside a step) from one this process is actively writing.
//
// Keyed by target, not org: two owners of the same org may build bundles on two
// runtimes at once, and those runs share nothing but the org id.
const activeBundles = new Set<string>();
const mutexKey = (orgId: string, target: string) => `${orgId}:${target}`;

export function isBundleBuilding(orgId: string, target: string): boolean {
  return activeBundles.has(mutexKey(orgId, target));
}

/**
 * Drive the nine bundle steps to completion, or until one fails and blocks its
 * dependents. Resuming is this same call: durable per-step state decides what
 * actually runs, and every executor is find-or-create, so a BFF restart in the
 * middle of a ten-minute Cloud Build job re-attaches to that build.
 *
 * `target` is runTarget(sel) — the caller passes it in rather than deriving it here
 * so the same value can be used to answer "is this build already running" before the
 * stream opens.
 */
export function runBundleBuild(
  sel: BundleSelection,
  target: string,
  ctx: Omit<StepContext<BundleStepId>, 'results'>,
  onEvent?: MachineDeps<BundleStepId>['onEvent'],
  deps: Partial<Parameters<typeof bundleExecutors>[1]> = {},
): ReturnType<typeof runMachine<BundleStepId>> {
  const key = mutexKey(ctx.orgId, target);
  if (activeBundles.has(key)) {
    return Promise.reject(new Error(`a bundle build for ${target} is already running in this process`));
  }
  activeBundles.add(key);
  return (async () => {
    try {
      // Safe now that this process owns the target: a 'running' row here was left by
      // a dead run, and a step parked as running would never be selected again.
      await resetStaleBundleStates(ctx.orgId, target);
      return await runMachine<BundleStepId>(BUNDLE_STEPS, {
        ctx,
        executors: bundleExecutors(sel, deps as never),
        // The machine's state pair is (orgId, state)-shaped, so the target is closed
        // over here. Its idempotency key stays (org, step) — the row identity comes
        // from the (org, target, step) primary key, and the external idempotency that
        // actually matters is the deterministic Cloud Build id, buildId(org, target).
        loadStates: (orgId) => loadBundleStates(orgId, target),
        saveState: (orgId, state) => saveBundleState(orgId, target, state),
        onEvent,
      });
    } finally {
      activeBundles.delete(key);
    }
  })();
}
