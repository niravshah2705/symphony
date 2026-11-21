import { litellm } from '../clients/litellm.ts';

export interface LitellmCrossCheck {
  globalDaily: { date: string; spend: number }[];
  teamSpend: Record<string, number>;
}

// Flexprice is the per-org/project/user source of truth; LiteLLM spend is a sanity
// cross-check. OSS exposes global daily spend and per-team accrued spend only.
export async function litellmCrossCheck(projectIds: string[]): Promise<LitellmCrossCheck> {
  const globalDaily = await litellm.globalSpendLogs().catch(() => []);
  const teamSpend: Record<string, number> = {};
  for (const id of projectIds) {
    const info = await litellm.teamInfo(id).catch(() => undefined);
    const spend = info?.team_info?.spend;
    if (typeof spend === 'number') teamSpend[id] = spend;
  }
  return { globalDaily, teamSpend };
}