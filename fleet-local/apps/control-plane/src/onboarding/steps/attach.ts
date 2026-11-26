import { attachAgent } from '../../db/projects.ts';
import { labelResource } from '../../clients/k8s.ts';
import { config } from '../../config.ts';
import { modelAgentName, orgNamespace } from '../names.ts';
import type { StepExecutor } from '../machine.ts';

// Diagram 4 (+P6): bind the DEFAULT-model Agent to the project row (chat may
// override per session by picking another rendered agent) and stamp the project
// UUID onto every per-model CR so k8s queries join back to the canonical id.
export const attachStep: StepExecutor = async (ctx) => {
  const projectId = ctx.results.project?.projectId as string | undefined;
  if (!projectId) throw new Error('attach step: project result missing');
  const ns = orgNamespace(ctx.orgSlug);
  const def = config.modelCatalog.find((m) => m.default) ?? config.modelCatalog[0]!;
  const name = modelAgentName(ctx.orgSlug, def.id);
  await attachAgent(projectId, name, ns);
  for (const m of config.modelCatalog) {
    const name = modelAgentName(ctx.orgSlug, m.id);
    try {
      await labelResource('agents.api.kagent.dev', name, ns, { 'fleet.local/project-id': projectId });
    } catch (err) {
      // An experimental agent may legitimately be absent (its objects are skipped
      // when no runtime image is configured); the project binding above is what
      // chat needs, so a missing label here is not a failed onboarding.
      if (!/not found/i.test(String(err))) throw err;
    }
  }
  return { projectId, agentName: name, namespace: ns };
};