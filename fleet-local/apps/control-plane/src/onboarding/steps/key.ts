import { config } from '../../config.ts';
import { litellm } from '../../clients/litellm.ts';
import { applyManifest, getJson } from '../../clients/k8s.ts';
import { keyAlias, litellmSecretKey, litellmSecretName, litellmModelList, orgNamespace, qoderSecretKey } from '../names.ts';
import type { StepExecutor } from '../machine.ts';

// Diagram 8: a team-scoped LiteLLM virtual key, persisted ONLY as a k8s Secret in
// the org namespace (never in the DB result). Idempotent: an existing Secret is
// reused verbatim, so a retry never mints a second key.
//
// The key is written under two names: `key` (what the claude/codex/kagent
// ModelConfigs read) and QODER_API_KEY (what the qoder BYO runtime's BYOK
// provider reads, via ModelConfig.apiKeySecretKey). One Secret, one value, so a
// tenant has a single rotation path.
export const keyStep: StepExecutor = async (ctx) => {
  const projectId = ctx.results.project?.projectId as string | undefined;
  const projectSlug = (ctx.results.project?.slug as string | undefined) ?? 'default';
  if (!projectId) throw new Error('key step: project result missing');

  const ns = orgNamespace(ctx.orgSlug);
  const secretName = litellmSecretName(ctx.orgSlug, projectSlug);
  const manifest = (valueB64: string) =>
    `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ${secretName}\n  namespace: ${ns}\n` +
    `  labels:\n    fleet.local/org-id: ${ctx.orgId}\n    fleet.local/project-id: ${projectId}\n` +
    `type: Opaque\ndata:\n  ${litellmSecretKey}: ${valueB64}\n  ${qoderSecretKey}: ${valueB64}\n`;

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
    await applyManifest(manifest(Buffer.from(generated.key).toString('base64')));
  } else if (!existing.data[qoderSecretKey]) {
    // A Secret minted before Qoder existed: copy its own key across, never re-mint.
    await applyManifest(manifest(existing.data[litellmSecretKey]));
  }

  return { secretName, secretKey: litellmSecretKey, namespace: ns, projectId, keyAlias: keyAlias(ctx.orgId, projectId) };
};