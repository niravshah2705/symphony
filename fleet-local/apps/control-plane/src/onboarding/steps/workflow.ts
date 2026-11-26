import { config } from '../../config.ts';
import { helmUpgradeInstall } from '../../clients/k8s.ts';
import { helmRelease, orgNamespace, tenantId } from '../names.ts';
import { buildTenantValues } from '../tenant-values.ts';
import type { StepExecutor } from '../machine.ts';

// Diagram 3 (+P6/P7/P8/P9): install the tenant's kagent execution surface from
// the vendored chart. The values document is built by tenant-values.ts (shared
// with scripts/fixes), so onboarding and a sync run render the same objects.
// --wait=false; the agent step polls.
export const workflowStep: StepExecutor = async (ctx) => {
  const projectId = ctx.results.project?.projectId as string | undefined;
  const secretName = ctx.results.key?.secretName as string | undefined;
  if (!projectId || !secretName) throw new Error('workflow step: project/key results missing');

  const ns = orgNamespace(ctx.orgSlug);
  const id = tenantId(ctx.orgSlug);
  const values = buildTenantValues({
    orgId: ctx.orgId,
    orgSlug: ctx.orgSlug,
    projectId,
    secretName,
    catalog: config.modelCatalog,
    cfg: {
      snapshotRoot: config.snapshotRoot,
      litellmUrl: config.litellmUrl,
      qoderRuntimeImage: config.qoderRuntimeImage,
      qoderAdapterCommand: config.qoderAdapterCommand,
      qoderApiKeyEnv: config.qoderApiKeyEnv,
      customClaudeImage: config.customClaudeImage,
    },
  });

  const release = helmRelease(ctx.orgSlug);
  await helmUpgradeInstall({ release, chart: config.tenantChartPath, namespace: ns, values });

  return { release, namespace: ns, tenantId: id, projectId };
};
