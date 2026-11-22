import { waitForReady } from '../../clients/k8s.ts';
import { agentName, orgNamespace } from '../names.ts';
import type { StepExecutor } from '../machine.ts';

// Diagram 7: block until the tenant Agent is Ready (substrate auto-creates the
// atespace + golden snapshot for it — the first wake pays the build).
export const agentStep: StepExecutor = async (ctx) => {
  const ns = orgNamespace(ctx.orgSlug);
  const name = agentName(ctx.orgSlug);
  await waitForReady('agents.api.kagent.dev', name, ns, 300);
  return { agentNames: [name], namespace: ns };
};
