import { ensureOrg } from '../../db/orgs.ts';
import type { StepExecutor } from '../machine.ts';

// Diagram 1: mint/adopt the canonical org UUID (the DB is its source). LiteLLM
// organizations are Enterprise-only on this OSS proxy, so the org carries no
// LiteLLM entity — its UUID is adopted by Flexprice (customer), baggage and k8s
// labels, and org-level spend control is the Flexprice wallet. Project/key budgets
// (steps 2b/8/9) provide native LiteLLM enforcement.
export const orgStep: StepExecutor = async (ctx) => {
  const org = await ensureOrg(ctx.orgSlug, ctx.orgName);
  return { orgId: org.id, slug: org.slug };
};