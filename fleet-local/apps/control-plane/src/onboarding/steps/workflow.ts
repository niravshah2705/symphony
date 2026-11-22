import { FLEET_HEADERS } from '@fleet-local/shared';
import { config } from '../../config.ts';
import { helmUpgradeInstall } from '../../clients/k8s.ts';
import { helmRelease, litellmSecretKey, orgNamespace, tenantId, workerPoolName } from '../names.ts';
import type { StepExecutor } from '../machine.ts';

const ACTOR_OTLP = 'http://opentelemetry-collector.otel-system.svc:4317';

// P7: claude-harness release for the installed controller contract; the Harness
// CRD rejects tag references, so this is pinned to the manifest-list digest.
const CLAUDE_HARNESS_IMAGE =
  'ghcr.io/kagent-dev/kagent/claude-harness@sha256:bfbb526739439af92cea2282553500a3863dc66fad30838c68d57b6865e55fe4';

const OTEL_ENV = [
  { name: 'OTEL_PROPAGATORS', value: 'tracecontext,baggage' },
  { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: ACTOR_OTLP },
];

// spec.env OTEL_RESOURCE_ATTRIBUTES is merged with the controller's own values,
// so both harnesses can carry the org attribute.
const fleetOrgAttr = (orgId: string) => ({ name: 'OTEL_RESOURCE_ATTRIBUTES', value: `fleet.org_id=${orgId}` });

// Diagram 3 (+P6/P7/P8): install the tenant's kagent execution surface from the
// vendored chart. One ModelConfig + AgentTemplate + Agent per catalog model
// (agent "<id>-worker"), so the chat can pick the model by session. Static
// x-fleet-* headers carry the canonical UUIDs; Harness env turns on W3C baggage
// propagation so the caller's fleet_user_id / conversation id reach LiteLLM.
// runtime:"claude" entries compile on the claude-harness image instead: an
// Anthropic-provider ModelConfig (baseUrl + Secret-referenced key injected as
// x-api-key by the egress gateway — the adapter owns every ANTHROPIC_* env var
// and rejects defaultHeaders, so fleet attribution rides on the key).
// runtime:"codex" entries compile on the release-bundled codex-harness image:
// OpenAI-provider ModelConfig with apiFormat responses and NO defaultHeaders
// (codex rejects them); the adapter compiles OPENAI_API_KEY/CODEX_HOME/AWS_*
// from the ModelConfig, so those names stay out of Harness env.
// --wait=false; the agent step polls.
export const workflowStep: StepExecutor = async (ctx) => {
  const projectId = ctx.results.project?.projectId as string | undefined;
  const secretName = ctx.results.key?.secretName as string | undefined;
  if (!projectId || !secretName) throw new Error('workflow step: project/key results missing');

  const ns = orgNamespace(ctx.orgSlug);
  const id = tenantId(ctx.orgSlug);
  const fleetHeaders = { [FLEET_HEADERS.orgId]: ctx.orgId, [FLEET_HEADERS.projectId]: projectId };
  const catalog = config.modelCatalog;
  const hasClaude = catalog.some((m) => m.runtime === 'claude');
  const hasCodex = catalog.some((m) => m.runtime === 'codex');

  const harnessName = (runtime?: string) => (runtime === 'claude' ? 'claude' : runtime === 'codex' ? 'codex' : 'app');

  const values = {
    namespace: ns,
    tenant: { id, snapshotRoot: `${config.snapshotRoot}/${id}` },
    workerPool: { name: workerPoolName(ctx.orgSlug) },
    litellm: {
      baseUrl: `${config.litellmUrl}/v1`,
      anthropicBaseUrl: config.litellmUrl,
      apiKeySecret: secretName,
      apiKeySecretKey: litellmSecretKey,
    },
    models: catalog.map((m) =>
      m.runtime === 'claude'
        ? { name: m.id, provider: 'Anthropic', model: m.model }
        : m.runtime === 'codex'
          ? { name: m.id, provider: 'OpenAI', model: m.model, apiFormat: 'responses', noDefaultHeaders: true }
          : {
              name: m.id,
              provider: 'OpenAI',
              model: m.model,
              apiFormat: 'chatCompletions',
              stream: true,
              defaultHeaders: fleetHeaders,
            },
    ),
    harnesses: [
      { name: 'app', type: 'kagent', env: [...OTEL_ENV, fleetOrgAttr(ctx.orgId)] },
      ...(hasClaude ? [{ name: 'claude', type: 'claude', image: CLAUDE_HARNESS_IMAGE, env: [...OTEL_ENV, fleetOrgAttr(ctx.orgId)] }] : []),
      // Empty image = the codex-harness shipped with the installed kagent release.
      ...(hasCodex ? [{ name: 'codex', type: 'codex', env: [...OTEL_ENV, fleetOrgAttr(ctx.orgId)] }] : []),
    ],
    templates: catalog.map((m) => ({
      name: `${m.id}-coding`,
      modelConfig: m.id,
      description: `Fleet coding workflow (${m.label})`,
      systemPrompt: 'You are a concise coding agent. Plan, then act.\n',
    })),
    agents: catalog.map((m) => ({
      name: `${m.id}-worker`,
      template: `${m.id}-coding`,
      harness: harnessName(m.runtime),
    })),
    commonLabels: { 'fleet.local/org-id': ctx.orgId, 'fleet.local/project-id': projectId },
  };

  const release = helmRelease(ctx.orgSlug);
  await helmUpgradeInstall({ release, chart: config.tenantChartPath, namespace: ns, values });

  return { release, namespace: ns, tenantId: id, projectId };
};