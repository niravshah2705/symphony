import { FLEET_HEADERS, MODELS } from '@fleet-local/shared';
import { config } from '../../config.ts';
import { helmUpgradeInstall } from '../../clients/k8s.ts';
import { helmRelease, litellmSecretKey, orgNamespace, tenantId, workerPoolName } from '../names.ts';
import type { StepExecutor } from '../machine.ts';

const ACTOR_OTLP = 'http://opentelemetry-collector.otel-system.svc:4317';

const OTEL_ENV = [
  { name: 'OTEL_PROPAGATORS', value: 'tracecontext,baggage' },
  { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: ACTOR_OTLP },
];

// spec.env OTEL_RESOURCE_ATTRIBUTES is merged with the controller's own values,
// so the harness can carry the org attribute.
const fleetOrgAttr = (orgId: string) => ({ name: 'OTEL_RESOURCE_ATTRIBUTES', value: `fleet.org_id=${orgId}` });

// Diagram 3: install the tenant's kagent execution surface from the vendored
// chart — one ModelConfig per platform model, one kagent Harness, and the
// single "worker" Agent the chat talks to. Static x-fleet-* headers carry the
// canonical UUIDs; Harness env turns on W3C baggage propagation so the caller's
// fleet_user_id / conversation id reach LiteLLM. --wait=false; the agent step polls.
export const workflowStep: StepExecutor = async (ctx) => {
  const projectId = ctx.results.project?.projectId as string | undefined;
  const secretName = ctx.results.key?.secretName as string | undefined;
  if (!projectId || !secretName) throw new Error('workflow step: project/key results missing');

  const ns = orgNamespace(ctx.orgSlug);
  const id = tenantId(ctx.orgSlug);
  const fleetHeaders = { [FLEET_HEADERS.orgId]: ctx.orgId, [FLEET_HEADERS.projectId]: projectId };

  const values = {
    namespace: ns,
    tenant: { id, snapshotRoot: `${config.snapshotRoot}/${id}` },
    workerPool: { name: workerPoolName(ctx.orgSlug) },
    litellm: {
      baseUrl: `${config.litellmUrl}/v1`,
      apiKeySecret: secretName,
      apiKeySecretKey: litellmSecretKey,
    },
    models: Object.entries(MODELS).map(([name, model]) => ({
      name,
      provider: 'OpenAI',
      model,
      apiFormat: 'chatCompletions',
      stream: true,
      defaultHeaders: fleetHeaders,
    })),
    harnesses: [{ name: 'app', type: 'kagent', env: [...OTEL_ENV, fleetOrgAttr(ctx.orgId)] }],
    templates: [
      {
        name: 'coding',
        modelConfig: 'mock',
        description: 'Fleet coding workflow',
        systemPrompt: 'You are a concise coding agent. Plan, then act.\n',
      },
    ],
    agents: [{ name: 'worker', template: 'coding', harness: 'app' }],
    commonLabels: { 'fleet.local/org-id': ctx.orgId, 'fleet.local/project-id': projectId },
  };

  const release = helmRelease(ctx.orgSlug);
  await helmUpgradeInstall({ release, chart: config.tenantChartPath, namespace: ns, values });

  return { release, namespace: ns, tenantId: id, projectId };
};