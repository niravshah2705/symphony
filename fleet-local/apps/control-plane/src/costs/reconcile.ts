import { flexprice } from '../clients/flexprice.ts';
import { defaultWindow, orgCosts, type Window } from './flexprice.ts';
import { litellmCrossCheck } from './litellm.ts';
import { actorSeconds, type PromSample } from './prom.ts';
import type { OrgCosts } from './flexprice.ts';
import type { LitellmCrossCheck } from './litellm.ts';

export interface ReconciledCosts {
  orgId: string;
  window: Window;
  flexprice: OrgCosts;
  litellm: LitellmCrossCheck;
  prometheus: PromSample[];
  walletBalance?: unknown;
}

// Dashboard payload: Flexprice (authoritative per-org/project/user) + LiteLLM spend
// cross-check + Prometheus actor seconds + live wallet balance. Each secondary
// source degrades to empty on failure so the dashboard still renders Flexprice.
export async function reconcile(
  orgId: string,
  projectIds: string[],
  opts: { window?: Window; walletId?: string } = {},
): Promise<ReconciledCosts> {
  const window = opts.window ?? defaultWindow();
  const [fp, ll, prom] = await Promise.all([
    orgCosts(orgId, window),
    litellmCrossCheck(projectIds),
    actorSeconds(orgId).catch(() => [] as PromSample[]),
  ]);
  const walletBalance = opts.walletId
    ? await flexprice.walletBalance(opts.walletId).catch(() => undefined)
    : undefined;
  return { orgId, window, flexprice: fp, litellm: ll, prometheus: prom, walletBalance };
}