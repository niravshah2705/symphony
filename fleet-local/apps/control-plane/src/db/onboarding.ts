import type { OnboardingStepId, StepState } from '@fleet-local/shared';
import { query } from './client.ts';

interface RunRow {
  step: string;
  status: string;
  attempt: number;
  idempotency_key: string;
  result_json: Record<string, unknown> | null;
  error: string | null;
}

export async function loadStates(orgId: string): Promise<Partial<Record<OnboardingStepId, StepState>>> {
  const res = await query<RunRow>(
    'SELECT step, status, attempt, idempotency_key, result_json, error FROM onboarding_runs WHERE org_id = $1',
    [orgId],
  );
  const out: Partial<Record<OnboardingStepId, StepState>> = {};
  for (const r of res.rows) {
    out[r.step as OnboardingStepId] = {
      step: r.step as OnboardingStepId,
      status: r.status as StepState['status'],
      attempt: r.attempt,
      idempotencyKey: r.idempotency_key,
      result: r.result_json ?? undefined,
      error: r.error ?? undefined,
    };
  }
  return out;
}

export async function saveState(orgId: string, state: StepState): Promise<void> {
  await query(
    `INSERT INTO onboarding_runs (org_id, step, status, attempt, idempotency_key, result_json, error, updated_at)
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