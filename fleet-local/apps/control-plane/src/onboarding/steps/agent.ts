import { waitForReady } from '../../clients/k8s.ts';
import { config } from '../../config.ts';
import { modelAgentName, orgNamespace } from '../names.ts';
import type { StepExecutor } from '../machine.ts';

// Diagram 7 (+P6): the workflow release rendered one Agent per catalog model;
// block until every one is Ready (substrate auto-creates the atespace + golden
// snapshot per agent — first nemotron/claude build pulls its snapshot too).
export const agentStep: StepExecutor = async (ctx) => {
  const ns = orgNamespace(ctx.orgSlug);
  const names = config.modelCatalog.map((m) => modelAgentName(ctx.orgSlug, m.id));
  for (const name of names) {
    await waitForReady('agents.api.kagent.dev', name, ns, 300);
  }
  return { agentNames: names, namespace: ns };
};