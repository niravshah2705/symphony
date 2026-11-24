import { config } from '../config.ts';
import { fetchJson, HttpError } from './http.ts';

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${config.litellmMasterKey}` };
}

const url = (path: string) => `${config.litellmUrl}${path}`;

// NOTE: LiteLLM *organizations* are an Enterprise-only feature on this OSS proxy
// (/organization/* returns a license error). The canonical org UUID still lives in
// the BFF DB, Flexprice customer, baggage and k8s labels; native budget enforcement
// here is at the TEAM (project) and KEY level, plus the Flexprice wallet at org level.

export function isAlreadyExists(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  if (err.status !== 400 && err.status !== 409) return false;
  return /already exists|duplicate|exists/i.test(err.body);
}

async function infoOrUndefined<T>(path: string): Promise<T | undefined> {
  try {
    return await fetchJson<T>(url(path), { headers: headers() });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return undefined;
    throw err;
  }
}

export interface Budget {
  max_budget?: number;
  budget_duration?: string;
}

export interface TeamInfo {
  team_id: string;
  team_info?: { spend?: number; max_budget?: number; budget_duration?: string; model_spend?: Record<string, number> };
}

export const litellm = {
  teamInfo(teamId: string) {
    return infoOrUndefined<TeamInfo>(`/team/info?team_id=${encodeURIComponent(teamId)}`);
  },
  newTeam(teamId: string, models: string[], budget: Budget) {
    return fetchJson<{ team_id: string }>(url('/team/new'), {
      headers: headers(),
      body: { team_id: teamId, models, ...budget },
    });
  },
  updateTeam(teamId: string, budget: Budget) {
    return fetchJson(url('/team/update'), {
      headers: headers(),
      body: { team_id: teamId, ...budget },
    });
  },
  generateKey(params: {
    key_alias: string;
    team_id: string;
    models: string[];
    tags?: string[];
    metadata?: Record<string, unknown>;
  } & Budget) {
    return fetchJson<{ key: string; token_id?: string }>(url('/key/generate'), {
      headers: headers(),
      body: params,
    });
  },
  updateKey(key: string, budget: Budget) {
    return fetchJson(url('/key/update'), {
      headers: headers(),
      body: { key, ...budget },
    });
  },
  // Global daily spend (GET). OSS does not break this down per org; it is a sanity
  // cross-check against Flexprice, which is the per-org/project/user source of truth.
  globalSpendLogs() {
    return fetchJson<{ date: string; spend: number }[]>(url('/global/spend/logs'), { headers: headers() });
  },
};