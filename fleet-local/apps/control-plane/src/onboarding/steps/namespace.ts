import { config } from '../../config.ts';
import { applyManifest, helmGetValues, helmUpgradeInstall } from '../../clients/k8s.ts';
import { orgNamespace, workerPoolName } from '../names.ts';
import type { StepExecutor } from '../machine.ts';

interface NamespacePolicy {
  allowedNamespaces: string[];
  atespace: string;
}

// Diagram 6: the tenant namespace + its gVisor WorkerPool, and the substrate
// credentialProvider gate that lets actors in this namespace fetch credentials.
// The parent substrate release is patched with --reuse-values only (never the
// podcert/atelet sub-releases).
export const namespaceStep: StepExecutor = async (ctx) => {
  const ns = orgNamespace(ctx.orgSlug);
  const pool = workerPoolName(ctx.orgSlug);

  await applyManifest(
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: ns,
        labels: {
          'ate.dev/api-access': 'true',
          'kagent.io/tenancy': ctx.orgSlug,
          'fleet.local/org-id': ctx.orgId,
        },
      },
    }),
  );

  await applyManifest(
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: `${pool}-pool`, namespace: ns, labels: { 'fleet.local/org-id': ctx.orgId } },
    }),
  );

  await applyManifest(
    JSON.stringify({
      apiVersion: 'ate.dev/v1',
      kind: 'WorkerPool',
      metadata: {
        name: pool,
        namespace: ns,
        labels: {
          'kagent.dev/worker-pool-name': pool,
          'kagent.dev/worker-pool-namespace': ns,
          'fleet.local/org-id': ctx.orgId,
        },
      },
      spec: {
        replicas: 1,
        sandboxClasses: [{ name: 'gvisor', configRef: { name: 'gvisor-default' } }],
        template: { serviceAccountName: `${pool}-pool` },
        workerImage: config.workerImage,
      },
    }),
  );

  const values = await helmGetValues('substrate', config.substrateNamespace);
  const cp = (values.credentialProvider ?? {}) as { namespacePolicies?: NamespacePolicy[] };
  const policies = cp.namespacePolicies ?? [];
  if (!policies.some((p) => p.atespace === ns && p.allowedNamespaces?.includes(ns))) {
    policies.push({ allowedNamespaces: [ns], atespace: ns });
    await helmUpgradeInstall({
      release: 'substrate',
      chart: config.substrateChart,
      namespace: config.substrateNamespace,
      version: config.substrateVersion,
      reuseValues: true,
      values: { credentialProvider: { ...cp, namespacePolicies: policies } },
    });
  }

  return { namespace: ns, workerPool: pool };
};