import { config } from '../../config.ts';
import { litellm } from '../../clients/litellm.ts';
import { applyManifest, getJson } from '../../clients/k8s.ts';
import { keyAlias, litellmSecretKey, litellmSecretName, litellmModelList, orgNamespace } from '../names.ts';
import type { StepExecutor } from '../machine.ts';

// Diagram 8: a team-scoped LiteLLM virtual key, persisted ONLY as a k8s Secret in
// the org namespace (never in the DB result). Idempotent: an existing Secret is
// reused verbatim, so a retry never mints a second key.
export const keyStep: StepExecutor = async (ctx) => {
  const projectId = ctx.results.project?.projectId as string | undefined;
  const projectSlug = (ctx.results.project?.slug as string | undefined) ?? 'default';
  if (!projectId) throw new Error('key step: project result missing');

  const ns = orgNamespace(ctx.orgSlug);
  const secretName = litellmSecretName(ctx.orgSlug, projectSlug);

  const existing = await getJson<{ data?: Record<string, string> }>('secret', secretName, ns);
  if (!existing?.data?.[litellmSecretKey]) {
    const generated = await litellm.generateKey({
      key_alias: keyAlias(ctx.orgId, projectId),
      team_id: projectId,
      models: litellmModelList(config.modelCatalog),
      metadata: { fleet_org: ctx.orgId, fleet_project: projectId },
      max_budget: config.defaultProjectBudgetUsd,
      budget_duration: config.budgetDuration,
    });
    if (!(await getJson('namespace', ns))) {
      await applyManifest(`apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns}\n`);
    }
    const b64 = Buffer.from(generated.key).toString('base64');
    await applyManifest(
      `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ${secretName}\n  namespace: ${ns}\n` +
        `  labels:\n    fleet.local/org-id: ${ctx.orgId}\n    fleet.local/project-id: ${projectId}\n` +
        `type: Opaque\ndata:\n  ${litellmSecretKey}: ${b64}\n`,
    );
  }

  return { secretName, secretKey: litellmSecretKey, namespace: ns, projectId, keyAlias: keyAlias(ctx.orgId, projectId) };
};