import type { BundleStepId, StepState } from '@fleet-local/shared';
import { query } from './client.ts';

interface RunRow {
  target: string;
  step: string;
  status: string;
  attempt: number;
  idempotency_key: string;
  result_json: Record<string, unknown> | null;
  error: string | null;
}

// The bundle machine's state, one row per (org, target, step). It cannot reuse
// db/onboarding.ts's load/save because those are keyed (org, step) and a bundle
// machine is keyed (org, target, step): an org may hold several targets, and two
// concurrent runs sharing a row would write over each other's status.

export async function loadBundleStates(
  orgId: string,
  target: string,
): Promise<Partial<Record<BundleStepId, StepState<BundleStepId>>>> {
  const res = await query<RunRow>(
    `SELECT target, step, status, attempt, idempotency_key, result_json, error
       FROM bundle_runs WHERE org_id = $1 AND target = $2`,
    [orgId, target],
  );
  const out: Partial<Record<BundleStepId, StepState<BundleStepId>>> = {};
  for (const r of res.rows) {
    const step = r.step as BundleStepId;
    out[step] = {
      step,
      status: r.status as StepState<BundleStepId>['status'],
      attempt: r.attempt,
      idempotencyKey: r.idempotency_key,
      result: r.result_json ?? undefined,
      error: r.error ?? undefined,
    };
  }
  return out;
}

// The machine's loadStates/saveState take only (orgId, state), so the driver closes
// over the target: run.ts builds both half of the pair from one (orgId, target).
export async function saveBundleState(orgId: string, target: string, state: StepState<BundleStepId>): Promise<void> {
  await query(
    `INSERT INTO bundle_runs (org_id, target, step, status, attempt, idempotency_key, result_json, error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (org_id, target, step) DO UPDATE SET
       status = EXCLUDED.status,
       attempt = EXCLUDED.attempt,
       idempotency_key = EXCLUDED.idempotency_key,
       result_json = EXCLUDED.result_json,
       error = EXCLUDED.error,
       updated_at = now()`,
    [
      orgId,
      target,
      state.step,
      state.status,
      state.attempt,
      state.idempotencyKey,
      state.result ? JSON.stringify(state.result) : null,
      state.error ?? null,
    ],
  );
}

/**
 * A step the process died inside stays 'running' forever, and a running step is
 * never re-selected, so an interrupted build could not be resumed without this.
 * Only called for a target this process has no live run for, so it cannot race
 * itself, and scoped to the one target rather than the org so a second build in
 * flight is not reset out from under its own machine.
 */
export async function resetStaleBundleStates(orgId: string, target: string): Promise<number> {
  const res = await query(
    `UPDATE bundle_runs SET status = 'pending', updated_at = now()
      WHERE org_id = $1 AND target = $2 AND status = 'running'`,
    [orgId, target],
  );
  return res.rowCount ?? 0;
}

export interface BundleBuildRow {
  runtime: string;
  image: string;
  baseDigest: string;
  plugins: { id: string; version: string }[];
  dockerfileSha: string;
  bundleKey: string;
}

interface BuildRow {
  runtime: string;
  image: string;
  base_digest: string;
  plugins: BundleBuildRow['plugins'];
  dockerfile_sha: string;
  bundle_key: string;
}

/** What the tenant render reads: one current image per runtime. */
export async function listBundleBuilds(orgId: string): Promise<BundleBuildRow[]> {
  const res = await query<BuildRow>(
    `SELECT runtime, image, base_digest, plugins, dockerfile_sha, bundle_key
       FROM bundle_builds WHERE org_id = $1 ORDER BY runtime`,
    [orgId],
  );
  return res.rows.map((r) => ({
    runtime: r.runtime,
    image: r.image,
    baseDigest: r.base_digest,
    plugins: r.plugins ?? [],
    dockerfileSha: r.dockerfile_sha,
    bundleKey: r.bundle_key,
  }));
}

/** One row per (org, runtime): the newest successful build is the current image. */
export async function upsertBundleBuild(orgId: string, build: BundleBuildRow): Promise<void> {
  await query(
    `INSERT INTO bundle_builds (org_id, runtime, image, base_digest, plugins, dockerfile_sha, bundle_key, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (org_id, runtime) DO UPDATE SET
       image = EXCLUDED.image,
       base_digest = EXCLUDED.base_digest,
       plugins = EXCLUDED.plugins,
       dockerfile_sha = EXCLUDED.dockerfile_sha,
       bundle_key = EXCLUDED.bundle_key,
       updated_at = now()`,
    [orgId, build.runtime, build.image, build.baseDigest, JSON.stringify(build.plugins), build.dockerfileSha, build.bundleKey],
  );
}

/**
 * Called when a teardown finishes. The org row is kept (status 'deleted') as the
 * audit trail an offboarding is required to preserve, so the cascade does not fire
 * and these rows have to go explicitly: a deleted org still holding a current
 * bundle image would have a Harness rendered for it by any later re-onboard,
 * pointing at an Artifact Registry tag nobody remembers owning.
 */
export async function clearBundleBuilds(orgId: string): Promise<number> {
  const res = await query(`DELETE FROM bundle_builds WHERE org_id = $1`, [orgId]);
  return res.rowCount ?? 0;
}

export interface BundleRunSummary {
  target: string;
  states: Partial<Record<BundleStepId, StepState<BundleStepId>>>;
}

/**
 * The wizard's history: the targets this org has built, newest first, with every
 * step state for each. A run that was never started appears nowhere, which is the
 * point — the list is of attempts, not of possible selections.
 */
export async function listBundleRuns(orgId: string, limit = 8): Promise<BundleRunSummary[]> {
  const targets = await query<{ target: string }>(
    `SELECT target FROM bundle_runs WHERE org_id = $1
      GROUP BY target ORDER BY max(updated_at) DESC LIMIT $2`,
    [orgId, limit],
  );
  const out: BundleRunSummary[] = [];
  for (const row of targets.rows) {
    out.push({ target: row.target, states: await loadBundleStates(orgId, row.target) });
  }
  return out;
}
