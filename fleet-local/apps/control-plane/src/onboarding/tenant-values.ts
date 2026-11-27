// The tenant's kagent values document, built from the model catalog alone.
//
// This is the whole render contract for one tenant: ModelConfig + AgentTemplate +
// Agent per catalog entry, plus one Harness per runtime the catalog uses. It is a
// pure function of its inputs (no config, no cluster) so the shape is testable and
// the sync script (scripts/fixes) and onboarding cannot drift apart.
import { FLEET_HEADERS, type ModelCatalogEntry } from '@fleet-local/shared';
import { litellmSecretKey, orgNamespace, tenantId, workerPoolName } from './names.ts';

export const ACTOR_OTLP = 'http://opentelemetry-collector.otel-system.svc:4317';

// What the qodercli inside the Actor is given: a job-token envelope whose token is
// inert. Verified against the published 1.1.92 bundle —
// QODER_JOB_TOKEN is parsed and handed straight to loginWithJobToken, which skips
// /api/v1/jobToken/exchange entirely (the PAT that endpoint wants travels in a JSON
// body, and kagent substitutes headers only). The CLI then sends this value as
// `Authorization: Bearer <value>` on the origins the EgressPolicy authenticates, and
// refuses to run if it is absent ("Not logged in"). expireTime is a far-future
// constant: the CLI's own expiry check must never trigger a refresh it cannot do.
export const QODER_TOKEN_PLACEHOLDER_ENV = 'QODER_JOB_TOKEN';
export const QODER_TOKEN_PLACEHOLDER = 'kagent-egress-placeholder';
export const qoderJobTokenPlaceholder = (token = QODER_TOKEN_PLACEHOLDER) =>
  JSON.stringify({ token, expireTime: 4102444800 });

// P9: the shared web-fetch MCP server (deploy/webfetch) — streamable-HTTP is
// the only MCP protocol all harnesses speak, and the tenant renders a
// same-namespace RemoteMCPServer pointing at it, bound on every template.
export const WEBFETCH_MCP = {
  name: 'webfetch',
  description: 'Web page fetch (public internet only)',
  url: 'http://webfetch.kagent.svc.cluster.local:8087/mcp',
};

// P7: claude-harness release for the installed controller contract; the Harness
// CRD rejects tag references, so this is pinned to the manifest-list digest.
export const CLAUDE_HARNESS_IMAGE =
  'ghcr.io/kagent-dev/kagent/claude-harness@sha256:bfbb526739439af92cea2282553500a3863dc66fad30838c68d57b6865e55fe4';

const OTEL_ENV = [
  { name: 'OTEL_PROPAGATORS', value: 'tracecontext,baggage' },
  { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: ACTOR_OTLP },
];

// spec.env OTEL_RESOURCE_ATTRIBUTES is merged with the controller's own values,
// so every harness can carry the org attribute.
const fleetOrgAttr = (orgId: string) => ({ name: 'OTEL_RESOURCE_ATTRIBUTES', value: `fleet.org_id=${orgId}` });

export interface TenantValuesConfig {
  snapshotRoot: string;
  litellmUrl: string;
  qoderRuntimeImage: string;
  qoderAdapterCommand: string;
  qoderApiKeyEnv: string;
  qoderBearerOrigins: readonly string[];
  qoderGrantOrigins: readonly string[];
  qoderModelBaseUrl: string;
  customClaudeImage: string;
}

export interface TenantValuesInput {
  orgId: string;
  orgSlug: string;
  projectId: string;
  secretName: string;
  catalog: readonly ModelCatalogEntry[];
  cfg: TenantValuesConfig;
}

export const harnessName = (runtime?: string) =>
  runtime === 'claude' ? 'claude' : runtime === 'codex' ? 'codex' : runtime === 'qoder' ? 'qoder' : 'app';

export function buildTenantValues(input: TenantValuesInput) {
  const { orgId, orgSlug, projectId, secretName, cfg } = input;
  const ns = orgNamespace(orgSlug);
  const id = tenantId(orgSlug);
  const fleetHeaders = { [FLEET_HEADERS.orgId]: orgId, [FLEET_HEADERS.projectId]: projectId };
  // A qoder entry with no image to render is dropped wholesale: an Agent bound to
  // a Harness that does not exist would fail the chart's referential check with a
  // message that does not name the missing image.
  const catalog = input.catalog.filter((m) => m.runtime !== 'qoder' || cfg.qoderRuntimeImage !== '');
  const hasClaude = catalog.some((m) => m.runtime === 'claude');
  const hasCodex = catalog.some((m) => m.runtime === 'codex');
  const hasQoder = catalog.some((m) => m.runtime === 'qoder');
  const orgEnv = [...OTEL_ENV, fleetOrgAttr(orgId)];

  return {
    namespace: ns,
    tenant: { id, snapshotRoot: `${cfg.snapshotRoot}/${id}` },
    workerPool: { name: workerPoolName(orgSlug) },
    litellm: {
      baseUrl: `${cfg.litellmUrl}/v1`,
      anthropicBaseUrl: cfg.litellmUrl,
      apiKeySecret: secretName,
      apiKeySecretKey: litellmSecretKey,
    },
    // runtime:"claude" → Anthropic-provider ModelConfig (baseUrl + Secret-referenced
    // key injected as x-api-key by the egress gateway; the adapter owns every
    // ANTHROPIC_* env var and rejects defaultHeaders, so fleet attribution rides
    // on the key). runtime:"codex" → OpenAI provider with apiFormat responses and
    // NO defaultHeaders (codex rejects them); the adapter compiles
    // OPENAI_API_KEY/CODEX_HOME/AWS_* from the ModelConfig, so those names stay out
    // of Harness env. runtime:"qoder" → the Qoder endpoint itself, not LiteLLM: the
    // baseUrl is kagent's own network config for that origin, and the credential the
    // gateway substitutes on each call is the tenant Secret key named below.
    models: catalog.map((m) =>
      m.runtime === 'claude'
        ? { name: m.id, provider: 'Anthropic', model: m.model }
        : m.runtime === 'codex'
          ? { name: m.id, provider: 'OpenAI', model: m.model, apiFormat: 'responses', noDefaultHeaders: true }
          : m.runtime === 'qoder'
            ? {
                name: m.id,
                provider: 'OpenAI',
                model: m.model,
                apiFormat: 'chatCompletions',
                stream: true,
                defaultHeaders: fleetHeaders,
                // Direct to Qoder, not through LiteLLM. The runtime elects its own
                // model host (api1|api2|api3.qoder.sh) from Qoder's region endpoint
                // API, so this baseUrl is kagent's network config for the API origin;
                // the credential the gateway substitutes lives on the egress
                // destinations below, and it never enters the Actor.
                baseUrl: cfg.qoderModelBaseUrl,
                apiKeySecret: secretName,
                apiKeySecretKey: cfg.qoderApiKeyEnv,
              }
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
      { name: 'app', type: 'kagent', env: orgEnv },
      ...(hasClaude ? [{ name: 'claude', type: 'claude', image: CLAUDE_HARNESS_IMAGE, env: orgEnv }] : []),
      // Empty image = the codex-harness shipped with the installed kagent release.
      ...(hasCodex ? [{ name: 'codex', type: 'codex', env: orgEnv }] : []),
      // custom-claude: the claude adapter on the fleet-published claude-runtime
      // image, rendered in every tenant namespace as <tenant>-harness-custom-claude
      // so an Agent can harnessRef it locally. Empty image disables it; the chart
      // rejects an unpinned one.
      ...(cfg.customClaudeImage ? [{ name: 'custom-claude', type: 'claude', image: cfg.customClaudeImage, env: orgEnv }] : []),
      ...(hasQoder
        ? [
            {
              name: 'qoder',
              type: 'byo',
              image: cfg.qoderRuntimeImage,
              command: [cfg.qoderAdapterCommand],
              // The CLI needs *a* credential to put in its Authorization header and to
              // build its request signing from; the EgressPolicy replaces that header
              // at the gateway with the tenant's live job token, so this value stays
              // inert. Harness spec.env has no valueFrom, which is exactly why no
              // credential can live here.
              env: [...orgEnv, { name: QODER_TOKEN_PLACEHOLDER_ENV, value: qoderJobTokenPlaceholder() }],
            },
          ]
        : []),
    ],
    // EgressPolicy objects: the outward origins an Agent may reach, and — on the
    // origins that carry a bearer credential — the Secret key the gateway substitutes
    // on every call. This is the only place the tenant's Qoder credential is named,
    // and it is named as a reference, so the value never reaches the Actor.
    //
    // Which origins those are was measured, not guessed: capture of one successful
    // 1.1.92 turn shows `Bearer jt-...` on openapi.qoder.sh (userinfo) and
    // center.qoder.sh (region/endpoint election, metrics), while the model call on the
    // elected api*.qoder.sh carries a locally-built `Bearer COSY.<envelope>` derived
    // from that userinfo — so the model hosts need a plain grant, and authenticating
    // them would substitute over a signature and break it.
    //
    // kagent refuses `authentication` on a wildcard origin ("authentication requires an
    // exact HTTP(S) origin"), which is why the grant list stays wildcard-only.
    egress: hasQoder
      ? [
          {
            name: 'qoder',
            destinations: [
              ...[...new Set(cfg.qoderBearerOrigins)].map((origin) => ({
                origin,
                authentication: {
                  header: 'authorization',
                  prefix: 'Bearer ',
                  secretRef: { name: secretName, key: cfg.qoderApiKeyEnv },
                },
              })),
              ...cfg.qoderGrantOrigins.filter((origin) => !cfg.qoderBearerOrigins.includes(origin)).map((origin) => ({ origin })),
            ],
          },
        ]
      : [],
    mcp: [WEBFETCH_MCP],
    templates: catalog.map((m) => ({
      name: `${m.id}-coding`,
      modelConfig: m.id,
      description: `Fleet coding workflow (${m.label})`,
      systemPrompt: 'You are a concise coding agent. Plan, then act.\n',
      mcp: [WEBFETCH_MCP.name],
    })),
    agents: catalog.map((m) => ({
      name: `${m.id}-worker`,
      template: `${m.id}-coding`,
      harness: harnessName(m.runtime),
      // The Qoder endpoint is a third-party origin, so it is granted explicitly
      // rather than inferred; every other runtime stays on the in-cluster LiteLLM
      // grant kagent derives from its ModelConfig.
      ...(m.runtime === 'qoder' ? { egress: ['qoder'] } : {}),
    })),
    commonLabels: { 'fleet.local/org-id': orgId, 'fleet.local/project-id': projectId },
  };
}

export type TenantValues = ReturnType<typeof buildTenantValues>;
