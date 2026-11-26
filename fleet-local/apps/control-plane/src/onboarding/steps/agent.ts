import { waitForReady } from '../../clients/k8s.ts';
import { config } from '../../config.ts';
import { modelAgentName, orgNamespace } from '../names.ts';
import type { StepExecutor } from '../machine.ts';
import type { ModelCatalogEntry } from '@fleet-local/shared';

// The agents onboarding blocks for. An `experimental` entry is rendered but never
// waited on: a Qoder agent that does not turn Ready must not eat the 300s budget
// or fail the wizard for a tenant whose other agents are fine.
export function readyAgentNames(orgSlug: string, catalog: readonly ModelCatalogEntry[] = config.modelCatalog): string[] {
  return catalog.filter((m) => !m.experimental).map((m) => modelAgentName(orgSlug, m.id));
}

// Diagram 7 (+P6): the workflow release rendered one Agent per catalog model;
// block until every one is Ready (substrate auto-creates the atespace + golden
// snapshot per agent — first nemotron/claude build pulls its snapshot too).
export const agentStep: StepExecutor = async (ctx) => {
  const ns = orgNamespace(ctx.orgSlug);
  const names = readyAgentNames(ctx.orgSlug);
  const all = config.modelCatalog.map((m) => modelAgentName(ctx.orgSlug, m.id));
  for (const name of names) {
    await waitForReady('agents.api.kagent.dev', name, ns, 300);
  }
  return { agentNames: names, skipped: all.filter((n) => !names.includes(n)), namespace: ns };
};
