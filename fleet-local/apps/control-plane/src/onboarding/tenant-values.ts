// The tenant's kagent values document, built from the model catalog alone.
//
// This is the whole render contract for one tenant: ModelConfig + AgentTemplate +
// Agent per catalog entry, plus one Harness per runtime the catalog uses. It is a
// pure function of its inputs (no config, no cluster) so the shape is testable and
// the sync script (scripts/fixes) and onboarding cannot drift apart.
import { DIGEST_PIN, FLEET_HEADERS, type ModelCatalogEntry } from '@fleet-local/shared';
import { litellmSecretKey, orgNamespace, tenantId, workerPoolName } from './names.ts';

export const ACTOR_OTLP = 'http://opentelemetry-collector.otel-system.svc:4317';

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

/** The env every harness in the tenant carries. Exported because the bundle
 *  apply step merges into a live values document and must produce the identical
 *  list rather than a second copy of it. */
export const orgEnvironment = (orgId: string) => [...OTEL_ENV, fleetOrgAttr(orgId)];

/**
 * One built bundle, as the render needs it. `type` and `adapter` come from
 * BUNDLE_BASES at the call site rather than being derived here: this module is a
 * pure function of its inputs and must not gain a dependency on the runtime table,
 * which would make the sync script and onboarding able to disagree silently.
 */
export interface BundleHarnessValue {
  name: string;
  type: 'claude' | 'codex' | 'byo';
  image: string;
  adapter?: string;
  /** The model this bundle's agent talks to; defaults to the catalog's first entry. */
  model?: string;
}

export interface TenantValuesConfig {
  snapshotRoot: string;
  litellmUrl: string;
  qoderRuntimeImage: string;
  qoderAdapterCommand: string;
  qoderApiKeyEnv: string;
  customClaudeImage: string;
}

export interface TenantValuesInput {
  orgId: string;
  orgSlug: string;
  projectId: string;
  secretName: string;
  catalog: readonly ModelCatalogEntry[];
  cfg: TenantValuesConfig;
  /** Owner-built plugin bundles, appended after the catalog harnesses. */
  bundles?: readonly BundleHarnessValue[];
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
    // of Harness env. runtime:"qoder" → the same OpenAI wire, but the key is read
    // from the tenant Secret under the BYOK env name (QODER_API_KEY) rather than
    // the default one.
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
              // QODER_SDK_CUSTOM_BASE_URL_BYOK unlocks qodercli's custom-provider
              // path (the account's allow_byok switch must also be on). The
              // credential itself is never here: Harness env has no valueFrom, so
              // a key in this list would be plaintext in the CR.
              env: [...orgEnv, { name: 'QODER_SDK_CUSTOM_BASE_URL_BYOK', value: '1' }],
            },
          ]
        : []),
      ...bundleHarnesses(input.bundles ?? [], orgEnv),
    ],
    mcp: [WEBFETCH_MCP],
    templates: [
      ...catalogTemplates(catalog),
      ...bundleTemplates(input.bundles ?? [], catalog.map((m) => m.id)),
    ],
    agents: [
      ...catalogAgents(catalog),
      ...bundleAgents(input.bundles ?? [], catalog.map((m) => m.id)),
    ],
    commonLabels: { 'fleet.local/org-id': orgId, 'fleet.local/project-id': projectId },
  };
}

/**
 * A built bundle as one Harness entry. Two rules, both learned from the objects
 * above: an image that is not digest-pinned is dropped rather than rendered —
 * the CRD rejects a tag, and it does so after the release has been mutated — and
 * a `byo` harness must carry its adapter command, which the chart requires and
 * the claude/codex engines forbid. A `byo` entry with no adapter is a caller bug
 * rather than a configuration choice, so it throws instead of disappearing.
 */
export function bundleHarnessValue(b: BundleHarnessValue, orgEnv: { name: string; value: string }[]) {
  if (b.type === 'byo' && !b.adapter) throw new Error(`bundle ${b.name}: a byo harness needs its adapter command`);
  return {
    name: b.name,
    type: b.type,
    image: b.image,
    ...(b.type === 'byo' ? { command: [b.adapter!] } : {}),
    env: orgEnv,
  };
}

const renderable = (bundles: readonly BundleHarnessValue[]): BundleHarnessValue[] =>
  bundles.filter((b) => DIGEST_PIN.test(b.image));

export const bundleHarnesses = (
  bundles: readonly BundleHarnessValue[],
  orgEnv: { name: string; value: string }[],
) => renderable(bundles).map((b) => bundleHarnessValue(b, orgEnv));

// The bundle agent exists so an owner can chat a turn against the image they just
// built; it is the only way `verify` in the wizard means anything beyond "the
// cluster can pull this ref". It is labelled experimental in its description
// because the chart has no experimental flag to render — nothing in the CR would
// change if one were set here.
export const bundleTemplates = (bundles: readonly BundleHarnessValue[], modelIds: readonly string[]) => {
  const fallback = modelIds[0];
  if (!fallback) return [];
  return renderable(bundles).map((b) => ({
    name: `${b.name}-coding`,
    // A bundle may name its own model; one that this document does not carry would
    // fail the chart's referential check, so it falls back rather than throwing.
    modelConfig: b.model && modelIds.includes(b.model) ? b.model : fallback,
    description: `Plugin bundle on ${b.name} (experimental)`,
    systemPrompt: 'You are a concise coding agent. Plan, then act.\n',
    mcp: [WEBFETCH_MCP.name],
  }));
};

export const bundleAgents = (bundles: readonly BundleHarnessValue[], modelIds: readonly string[]) => {
  if (!modelIds[0]) return [];
  return renderable(bundles).map((b) => ({
    name: `${b.name}-worker`,
    template: `${b.name}-coding`,
    harness: b.name,
  }));
};

/**
 * Add or replace the bundle objects on a values document that already exists — the
 * read-modify-write `apply` step performs on the live release. Every bundle entry
 * is keyed by the `bundle-` name prefix, so a re-apply converges onto the stored
 * builds instead of accumulating a second copy of a runtime, and a bundle whose
 * build row was removed disappears from the release on the next apply.
 *
 * The model id comes from the document's own `models` list rather than the caller's
 * config, because the release is the thing being kept coherent: a template that
 * names a model the release does not have fails the chart's referential check.
 */
export function mergeTenantBundles(
  values: Record<string, unknown>,
  bundles: readonly BundleHarnessValue[],
  orgId: string,
) {
  const named = <T extends { name?: string }>(key: string) =>
    Array.isArray(values[key]) ? (values[key] as T[]) : [];
  const kept = <T extends { name?: string }>(key: string) =>
    named<T>(key).filter((entry) => !String(entry.name ?? '').startsWith('bundle-'));
  const modelIds = named<{ name: string }>('models').map((m) => String(m.name));

  return {
    ...values,
    harnesses: [...kept('harnesses'), ...bundleHarnesses(bundles, orgEnvironment(orgId))],
    templates: [...kept('templates'), ...bundleTemplates(bundles, modelIds)],
    agents: [...kept('agents'), ...bundleAgents(bundles, modelIds)],
  };
}

const catalogTemplates = (catalog: readonly ModelCatalogEntry[]) =>
  catalog.map((m) => ({
    name: `${m.id}-coding`,
    modelConfig: m.id,
    description: `Fleet coding workflow (${m.label})`,
    systemPrompt: 'You are a concise coding agent. Plan, then act.\n',
    mcp: [WEBFETCH_MCP.name],
  }));

const catalogAgents = (catalog: readonly ModelCatalogEntry[]) =>
  catalog.map((m) => ({
    name: `${m.id}-worker`,
    template: `${m.id}-coding`,
    harness: harnessName(m.runtime),
  }));

export type TenantValues = ReturnType<typeof buildTenantValues>;
