// Runtime configuration. Every credential arrives via environment (mounted from
// k8s Secrets in deploy/bff); nothing secret is baked into the repo. Defaults
// point at the in-cluster service DNS of the kind cluster `flexprice-local`.

import { DIGEST_PIN, parseModelCatalog, withQoderCatalog } from '@fleet-local/shared';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

function opt(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

// Qoder runtime. Empty image ⇒ no qoder harness/agent is rendered anywhere, so
// a deployment without the digest-pinned image cannot produce a dead agent. The
// CRD rejects a tag with a worse error, after onboarding has mutated the tenant,
// so validate the pin here.
const qoderRuntimeImage = opt('QODER_RUNTIME_IMAGE', '');
if (qoderRuntimeImage && !DIGEST_PIN.test(qoderRuntimeImage)) {
  throw new Error('QODER_RUNTIME_IMAGE must be pinned by @sha256 digest — the kagent Harness CRD rejects tags');
}

// The bundle keys a deployment only has to supply once the feature is enabled.
// Split out so `bundleEnabled: false` — the default — cannot break a boot.
function configBundleChecks() {
  if (opt('BUNDLE_ENABLED', '') !== 'true') {
    return {
      gcpProjectId: opt('GCP_PROJECT_ID', ''),
      gcpRegion: opt('GCP_REGION', ''),
      bundleArRepo: opt('BUNDLE_REPO', ''),
      bundleStageBucket: opt('BUNDLE_STAGE_BUCKET', ''),
      bundlePullHost: '',
      bundleBuildTimeoutMs: Number(opt('BUNDLE_BUILD_TIMEOUT_MS', '1200000')),
      gcpSaKeyPath: opt('GCP_SA_KEY_PATH', '/run/secrets/gcp/sa.json'),
    };
  }
  const missing = ['GCP_PROJECT_ID', 'GCP_REGION', 'BUNDLE_REPO'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`BUNDLE_ENABLED requires ${missing.join(', ')}`);
  const registry = opt('BUNDLE_REGISTRY', 'ar');
  // `kind` exists for a deployment that refuses to make an AR repo anonymously
  // readable: the Harness image must be pullable by a node with no GCP identity,
  // so it names the local registry the nodes can actually reach instead.
  if (registry === 'kind' && !process.env.BUNDLE_PULL_HOST) {
    throw new Error('BUNDLE_REGISTRY=kind requires BUNDLE_PULL_HOST, the registry address the cluster nodes can reach');
  }
  return {
    gcpProjectId: req('GCP_PROJECT_ID'),
    gcpRegion: req('GCP_REGION'),
    bundleArRepo: req('BUNDLE_REPO'),
    bundleStageBucket: opt('BUNDLE_STAGE_BUCKET', ''),
    bundlePullHost: opt('BUNDLE_PULL_HOST', ''),
    bundleBuildTimeoutMs: Number(opt('BUNDLE_BUILD_TIMEOUT_MS', '1200000')),
    gcpSaKeyPath: opt('GCP_SA_KEY_PATH', '/run/secrets/gcp/sa.json'),
  };
}

export const config = {  port: Number(opt('PORT', '8080')),
  host: opt('HOST', '0.0.0.0'),
  publicOrigin: opt('PUBLIC_ORIGIN', 'https://app.fleet.dev'),
  spaRoot: opt('SPA_ROOT', ''),

  // fleet_control lives on the shared flexprice postgres (db created in P0).
  databaseUrl: req('FLEET_DATABASE_URL'),

  // Google ID-token verification (the Web client reused from the frontend).
  googleClientId: req('GOOGLE_CLIENT_ID'),
  googleIssuer: 'https://accounts.google.com',
  sessionSecret: req('FLEET_SESSION_SECRET'),
  sessionCookie: '_fleet_sess',
  sessionTtlSeconds: 60 * 60 * 12,

  // kagent controller (trusted-proxy auth; NetworkPolicy on :8083 is load-bearing).
  kagentControllerUrl: opt('KAGENT_CONTROLLER_URL', 'http://kagent-controller.kagent.svc.cluster.local:8083'),

  // LiteLLM admin + model gateway.
  litellmUrl: opt('LITELLM_URL', 'http://litellm.litellm.svc.cluster.local:4000'),
  litellmMasterKey: req('LITELLM_MASTER_KEY'),

  // Flexprice billing API.
  flexpriceApiUrl: opt('FLEXPRICE_API_URL', 'http://flexprice-api.flexprice.svc.cluster.local'),
  flexpriceApiKey: req('FLEXPRICE_API_KEY'),
  flexpriceEnvironmentId: opt('FLEXPRICE_ENVIRONMENT_ID', ''),
  flexpricePlanId: opt('FLEXPRICE_PLAN_ID', ''),

  // Langfuse (unexposed; reached in-cluster).
  langfuseHost: opt('LANGFUSE_HOST', 'http://langfuse-web.langfuse.svc.cluster.local:3000'),
  langfusePublicKey: opt('LANGFUSE_PUBLIC_KEY', 'pk-lf-fleet-local'),
  langfuseSecretKey: req('LANGFUSE_SECRET_KEY'),

  // Observability.
  otlpEndpoint: opt('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://opentelemetry-collector.otel-system.svc.cluster.local:4318'),
  prometheusUrl: opt('PROMETHEUS_URL', 'http://prometheus.otel-system.svc.cluster.local:9090'),

  // Onboarding / tenant defaults.
  substrateNamespace: opt('SUBSTRATE_NAMESPACE', 'ate-system'),
  substrateChart: opt('SUBSTRATE_CHART', 'oci://ghcr.io/kagent-dev/substrate/helm/substrate'),
  substrateVersion: opt('SUBSTRATE_VERSION', '1.0.1'),
  workerImage: opt('WORKER_IMAGE', 'ghcr.io/kagent-dev/substrate/ateworker-gvisor:v1.0.0'),
  snapshotRoot: opt('SNAPSHOT_ROOT', 's3://ate-snapshots'),
  tenantChartPath: opt('TENANT_CHART_PATH', '/charts/kagent-tenant'),
  // The `custom-claude` Harness runs the claude adapter on a fleet-published
  // claude-runtime image instead of the release-bundled one. Pinned by @sha256
  // digest: the Harness CRD rejects tag references (see kagent-tenant validation).
  customClaudeImage: opt(
    'CUSTOM_CLAUDE_IMAGE',
    'ghcr.io/niravshah2705/symphony/claude-runtime@sha256:d88bbb3b8c823df38b31aebddd1b25469be3db9f43f9e3793aba08efdd27cf45',
  ),
  defaultOrgBudgetUsd: Number(opt('DEFAULT_ORG_BUDGET_USD', '50')),
  defaultProjectBudgetUsd: Number(opt('DEFAULT_PROJECT_BUDGET_USD', '20')),
  budgetDuration: opt('DEFAULT_BUDGET_DURATION', '30d'),
  sweeperIntervalSeconds: Number(opt('SWEEPER_INTERVAL_SECONDS', '60')),
  // P6 model catalog (id/label/litellm model per chat-selectable model).
  // Qoder appends itself only when its runtime image is configured.
  qoderRuntimeImage,
  qoderAdapterCommand: opt('QODER_ADAPTER_COMMAND', '/usr/local/bin/qoder-runtime'),
  // Env name the tenant Secret carries the LiteLLM virtual key under, for the
  // qoder BYOK provider. It is a name we author, not a qodercli built-in.
  qoderApiKeyEnv: opt('QODER_API_KEY_ENV', 'QODER_API_KEY'),

  // Bundle builds: the owner-facing pipeline that renders a plugin selection into
  // a Dockerfile, builds it in Cloud Build, and points a tenant Harness at it.
  // Off by default, because enabling it means the control plane holds a GCP
  // service account that can spend Cloud Build seconds and write an AR repo.
  bundleEnabled: opt('BUNDLE_ENABLED', '') === 'true',
  bundleRegistry: (() => {
    const v = opt('BUNDLE_REGISTRY', 'ar');
    if (v !== 'ar' && v !== 'kind') throw new Error('BUNDLE_REGISTRY must be ar (Artifact Registry) or kind (a local registry the nodes can reach)');
    return v as 'ar' | 'kind';
  })(),
  // Only validated once the feature is on: a deployment that has never heard of
  // bundles must not fail to boot over an unused key.
  ...(configBundleChecks()),

  modelCatalog: withQoderCatalog(parseModelCatalog(process.env.FLEET_MODELS), qoderRuntimeImage),
} as const;

export type Config = typeof config;