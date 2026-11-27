import { config } from '../../config.ts';
import { helmUpgradeInstall } from '../../clients/k8s.ts';
import { mintQoderToken } from '../../credentials/qoderTokens.ts';
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
      qoderBearerOrigins: config.qoderBearerOrigins,
      qoderGrantOrigins: config.qoderGrantOrigins,
      qoderModelBaseUrl: config.qoderModelBaseUrl,
      customClaudeImage: config.customClaudeImage,
    },
  });

  // Mint before the policy applies: an EgressPolicy whose Secret key still holds the
  // operator-seeded PAT substitutes a `pt-...` where Qoder expects a `jt-...`, which
  // is the failure this whole path exists to avoid. A tenant with no PAT returns
  // 'skipped' rather than throwing, so onboarding never blocks on a credential the
  // platform does not hold.
  await mintQoderToken({ namespace: ns, secretName, orgId: ctx.orgId });

  const release = helmRelease(ctx.orgSlug);
  await helmUpgradeInstall({ release, chart: config.tenantChartPath, namespace: ns, values });

  return { release, namespace: ns, tenantId: id, projectId };
};
