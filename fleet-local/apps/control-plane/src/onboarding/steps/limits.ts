import { config } from '../../config.ts';
import { litellm } from '../../clients/litellm.ts';
import { flexprice } from '../../clients/flexprice.ts';
import { getJson } from '../../clients/k8s.ts';
import { litellmSecretKey } from '../names.ts';
import type { StepExecutor } from '../machine.ts';

// Diagram 9: default limits are CONFIGURATION, not new enforcement code. LiteLLM
// native max_budget/budget_duration on org/team/key (429 at limit) + Flexprice
// spend-alert toggle. The virtual key is read back from its Secret to update it.
export const limitsStep: StepExecutor = async (ctx) => {
  const projectId = ctx.results.project?.projectId as string | undefined;
  const secretName = ctx.results.key?.secretName as string | undefined;
  const ns = ctx.results.key?.namespace as string | undefined;
  if (!projectId || !secretName || !ns) throw new Error('limits step: project/key results missing');

  const projectBudget = { max_budget: config.defaultProjectBudgetUsd, budget_duration: config.budgetDuration };

  // Org-level control is the Flexprice wallet (LiteLLM orgs are Enterprise-only);
  // native LiteLLM enforcement is the team (project) + key budget below.
  await litellm.updateTeam(projectId, projectBudget);

  const secret = await getJson<{ data?: Record<string, string> }>('secret', secretName, ns);
  const encoded = secret?.data?.[litellmSecretKey];
  if (encoded) {
    const key = Buffer.from(encoded, 'base64').toString('utf8');
    await litellm.updateKey(key, projectBudget);
  }

  await flexprice.setAlertConfig({ alert_enabled: true });

  return { projectBudget, alertsEnabled: true };
};