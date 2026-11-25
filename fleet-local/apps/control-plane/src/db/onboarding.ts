import type { OffboardingStepId, OnboardingStepId, StepState } from '@fleet-local/shared';
import { query } from './client.ts';

interface RunRow {
  step: string;
  status: string;
  attempt: number;
  idempotency_key: string;
  result_json: Record<string, unknown> | null;
  error: string | null;
}

// The two machines have identical row shapes and different step vocabularies
// (key, namespace and flexprice mean different things to each), so they live in
// two tables. The parameter is this union and nothing else — it is interpolated,
// never sourced from a request.
type RunsTable = 'onboarding_runs' | 'offboarding_runs';

async function load<S extends string>(orgId: string, table: RunsTable): Promise<Partial<Record<S, StepState<S>>>> {
  const res = await query<RunRow>(
    `SELECT step, status, attempt, idempotency_key, result_json, error FROM ${table} WHERE org_id = $1`,
    [orgId],
  );
  const out: Partial<Record<S, StepState<S>>> = {};
  for (const r of res.rows) {
    const step = r.step as S;
    out[step] = {
      step,
      status: r.status as StepState<S>['status'],
      attempt: r.attempt,
      idempotencyKey: r.idempotency_key,
      result: r.result_json ?? undefined,
      error: r.error ?? undefined,
    };
  }
  return out;
}

async function save<S extends string>(orgId: string, state: StepState<S>, table: RunsTable): Promise<void> {
  await query(
    `INSERT INTO ${table} (org_id, step, status, attempt, idempotency_key, result_json, error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (org_id, step) DO UPDATE SET
       status = EXCLUDED.status,
       attempt = EXCLUDED.attempt,
       idempotency_key = EXCLUDED.idempotency_key,
       result_json = EXCLUDED.result_json,
       error = EXCLUDED.error,
       updated_at = now()`,
    [
      orgId,
      state.step,
      state.status,
      state.attempt,
      state.idempotencyKey,
      state.result ? JSON.stringify(state.result) : null,
      state.error ?? null,
    ],
  );
}

export async function loadStates(
  orgId: string,
): Promise<Partial<Record<OnboardingStepId, StepState<OnboardingStepId>>>> {
  return load<OnboardingStepId>(orgId, 'onboarding_runs');
}

export async function saveState(orgId: string, state: StepState<OnboardingStepId>): Promise<void> {
  await save(orgId, state, 'onboarding_runs');
}

export async function loadOffboardStates(
  orgId: string,
): Promise<Partial<Record<OffboardingStepId, StepState<OffboardingStepId>>>> {
  return load<OffboardingStepId>(orgId, 'offboarding_runs');
}

export async function saveOffboardState(orgId: string, state: StepState<OffboardingStepId>): Promise<void> {
  await save(orgId, state, 'offboarding_runs');
}

// A step the process died inside stays 'running' forever, and a running step is
// never re-selected — so without this a teardown interrupted by a BFF restart could
// not be resumed, which would leave infrastructure (and spend) behind. Only called
// for an org this process has no live machine for, so it cannot race itself.
export async function resetStaleOffboardStates(orgId: string): Promise<number> {
  const res = await query(
    `UPDATE offboarding_runs SET status = 'pending', updated_at = now()
      WHERE org_id = $1 AND status = 'running'`,
    [orgId],
  );
  return res.rowCount ?? 0;
}
