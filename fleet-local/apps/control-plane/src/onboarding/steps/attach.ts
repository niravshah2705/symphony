import { attachAgent } from '../../db/projects.ts';
import { labelResource } from '../../clients/k8s.ts';
import { agentName, orgNamespace } from '../names.ts';
import type { StepExecutor } from '../machine.ts';

// Diagram 4: bind the tenant Agent to the project row and stamp the project
// UUID onto the CR so k8s queries join back to the canonical id.
export const attachStep: StepExecutor = async (ctx) => {
  const projectId = ctx.results.project?.projectId as string | undefined;
  if (!projectId) throw new Error('attach step: project result missing');
  const ns = orgNamespace(ctx.orgSlug);
  const name = agentName(ctx.orgSlug);
  await attachAgent(projectId, name, ns);
  await labelResource('agents.api.kagent.dev', name, ns, { 'fleet.local/project-id': projectId });
  return { projectId, agentName: name, namespace: ns };
};
