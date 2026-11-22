import { config } from '../../config.ts';
import { isAlreadyExists, litellm } from '../../clients/litellm.ts';
import { ensureProject } from '../../db/projects.ts';
import { litellmModelList } from '../names.ts';
import type { StepExecutor } from '../machine.ts';

export const DEFAULT_PROJECT_SLUG = 'default';

// Diagram 2: the canonical project UUID adopted verbatim by LiteLLM as team_id
// under the org, with its own native budget.
export const projectStep: StepExecutor = async (ctx) => {
  const project = await ensureProject(ctx.orgId, DEFAULT_PROJECT_SLUG, 'Default project');
  const models = litellmModelList(config.modelCatalog);
  const budget = { max_budget: config.defaultProjectBudgetUsd, budget_duration: config.budgetDuration };
  if (!(await litellm.teamInfo(project.id))) {
    try {
      await litellm.newTeam(project.id, models, budget);
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }
  return { projectId: project.id, slug: project.slug };
};