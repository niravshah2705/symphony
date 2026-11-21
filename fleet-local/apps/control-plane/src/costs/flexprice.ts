import { customerId, type CostRow } from '@fleet-local/shared';
import { flexprice, type FlexpriceEvent } from '../clients/flexprice.ts';

export interface Window {
  startTime: string;
  endTime: string;
}

export function defaultWindow(days = 30): Window {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

// Org-level scalar aggregate. Flexprice /v1/events/usage returns {value} for a
// SUM; always send property_name + explicit filters (the API needs both).
export async function usageScalar(
  orgId: string,
  propertyName: string,
  opts: { eventName?: string; window?: Window; filters?: Record<string, unknown> } = {},
): Promise<number> {
  const window = opts.window ?? defaultWindow();
  const res = await flexprice.usage({
    event_name: opts.eventName ?? 'ai.usage',
    aggregation_type: 'SUM',
    property_name: propertyName,
    external_customer_id: customerId(orgId),
    start_time: window.startTime,
    end_time: window.endTime,
    filters: opts.filters ?? { tagged: ['false'] },
  });
  return Number(res.value ?? 0);
}

const EVENT_CAP = 5000;

export async function fetchEvents(orgId: string, eventName: string, window: Window): Promise<FlexpriceEvent[]> {
  const out: FlexpriceEvent[] = [];
  let offset = 0;
  for (;;) {
    const page = await flexprice.listEvents({
      externalCustomerId: customerId(orgId),
      eventName,
      startTime: window.startTime,
      endTime: window.endTime,
      limit: 200,
      offset,
    });
    const events = page.events ?? [];
    out.push(...events);
    offset += events.length;
    if (!page.has_more || events.length === 0 || out.length >= EVENT_CAP) break;
  }
  return out;
}

export interface Breakdown {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  usd: number;
}

const empty = (): Breakdown => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, usd: 0 });
const num = (v: string | undefined) => Number(v ?? 0) || 0;

function addUsage(acc: Breakdown, props: Record<string, string>): void {
  acc.inputTokens += num(props.input_tokens);
  acc.outputTokens += num(props.output_tokens);
  acc.totalTokens += num(props.total_tokens);
  acc.usd += num(props.reported_cost);
}

export interface OrgCosts {
  orgId: string;
  window: Window;
  totals: Breakdown & { actorSeconds: number };
  byProject: Record<string, Breakdown>;
  byUser: Record<string, Breakdown>;
  rows: CostRow[];
}

// The usage endpoint only returns a scalar in this Flexprice version, so the
// per-project / per-user breakdown is aggregated from the event list (exact, and
// independent of rollup-consumer timing). Org totals cross-check via usageScalar.
export async function orgCosts(orgId: string, window: Window = defaultWindow()): Promise<OrgCosts> {
  const [usage, compute] = await Promise.all([
    fetchEvents(orgId, 'ai.usage', window),
    fetchEvents(orgId, 'fleet.actor_compute', window),
  ]);
  return aggregateCosts(orgId, window, usage, compute);
}

// Pure aggregation, separated from fetching so the cost math is unit-testable.
export function aggregateCosts(
  orgId: string,
  window: Window,
  usage: FlexpriceEvent[],
  compute: FlexpriceEvent[],
): OrgCosts {
  const totals = empty();
  const byProject: Record<string, Breakdown> = {};
  const byUser: Record<string, Breakdown> = {};
  const actorByProject: Record<string, number> = {};
  const actorByUser: Record<string, number> = {};
  let actorSeconds = 0;

  for (const ev of usage) {
    const p = ev.properties;
    addUsage(totals, p);
    if (p.raw_team) addUsage((byProject[p.raw_team] ??= empty()), p);
    if (p.raw_user) addUsage((byUser[p.raw_user] ??= empty()), p);
  }
  for (const ev of compute) {
    const secs = num(ev.properties.duration_seconds);
    actorSeconds += secs;
    const proj = ev.properties.project_id;
    const usr = ev.properties.user_id;
    if (proj) actorByProject[proj] = (actorByProject[proj] ?? 0) + secs;
    if (usr) actorByUser[usr] = (actorByUser[usr] ?? 0) + secs;
  }

  const rows: CostRow[] = Object.entries(byProject).map(([projectId, b]) => ({
    orgId,
    projectId,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    totalTokens: b.totalTokens,
    usd: b.usd,
    actorSeconds: actorByProject[projectId] ?? 0,
  }));

  return {
    orgId,
    window,
    totals: { ...totals, actorSeconds },
    byProject,
    byUser,
    rows,
  };
}