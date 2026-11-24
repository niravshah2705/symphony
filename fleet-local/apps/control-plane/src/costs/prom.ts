import { config } from '../config.ts';
import { fetchJson } from '../clients/http.ts';

export interface PromSample {
  metric: Record<string, string>;
  value: number;
}

interface PromResponse {
  status: string;
  data?: { result?: { metric: Record<string, string>; value: [number, string] }[] };
}

export async function promQuery(query: string): Promise<PromSample[]> {
  const res = await fetchJson<PromResponse>(
    `${config.prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`,
  );
  if (res.status !== 'success') return [];
  return (res.data?.result ?? []).map((r) => ({ metric: r.metric, value: Number(r.value[1]) || 0 }));
}

// The BFF metering sweeper emits this fleet-labelled counter (OTLP → collector →
// Prometheus), so the dashboard can group actor seconds by org/project/user even
// when substrate's own internal series carry different label names.
export const ACTOR_SECONDS_METRIC = 'fleet_actor_running_seconds_total';

export function actorSeconds(orgId: string): Promise<PromSample[]> {
  return promQuery(
    `sum by (fleet_org_id,project_id,user_id,agent_id,tier)(${ACTOR_SECONDS_METRIC}{fleet_org_id="${orgId}"})`,
  );
}