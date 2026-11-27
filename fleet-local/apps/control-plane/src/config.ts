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

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

// Qoder runtime. Empty image ⇒ no qoder harness/agent is rendered anywhere, so
// a deployment without the digest-pinned image cannot produce a dead agent. The
// CRD rejects a tag with a worse error, after onboarding has mutated the tenant,
// so validate the pin here.
const qoderRuntimeImage = opt('QODER_RUNTIME_IMAGE', '');
if (qoderRuntimeImage && !DIGEST_PIN.test(qoderRuntimeImage)) {
  throw new Error('QODER_RUNTIME_IMAGE must be pinned by @sha256 digest — the kagent Harness CRD rejects tags');
}

export const config = {
  port: Number(opt('PORT', '8080')),
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
  // Env name (and tenant Secret key) carrying the org's Qoder token, which the
  // EgressPolicy substitutes into the Authorization header on each call. It is a
  // name we author, not a qodercli built-in; it is NOT the LiteLLM virtual key.
  // Under the job-token design below it holds the DERIVED `jt-...` token.
  qoderApiKeyEnv: opt('QODER_API_KEY_ENV', 'QODER_API_KEY'),
  // Qoder authenticates a request two ways at once, and only one of them is a
  // header. The personal access token (`pt-...`) travels in the JSON *body* of
  // POST /api/v1/jobToken/exchange; the returned job token (`jt-...`, 24h) travels
  // as `Authorization: Bearer jt-...`. kagent substitutes headers only, so the
  // exchange runs here — outside the Actor — and the tenant Secret carries the
  // derived token. Verified against the pinned 1.1.92 bundle: with
  // QODER_JOB_TOKEN set to an inert placeholder and the gateway swapping in a real
  // jt, a model turn completes; with a bogus jt, /api/v1/userinfo returns
  // TOKEN_EXPIRE and the turn aborts.
  qoderPatSecretKey: opt('QODER_PAT_SECRET_KEY', 'QODER_PAT'),
  qoderRefreshSecretKey: opt('QODER_REFRESH_SECRET_KEY', 'QODER_REFRESH_TOKEN'),
  // Where the exchange lives, and the origins that carry a `Bearer jt-...`: the API
  // host (userinfo) plus the control host (region/endpoint election, metrics).
  qoderAuthBaseUrl: opt('QODER_AUTH_BASE_URL', 'https://openapi.qoder.sh'),
  qoderBearerOrigins: splitList(
    opt('QODER_BEARER_ORIGINS', 'https://openapi.qoder.sh,https://center.qoder.sh'),
  ),
  // The model host the CLI elects at runtime (api1|api2|api3.qoder.sh) authenticates
  // with a locally-built `Bearer COSY.<envelope>` derived from the userinfo the
  // substituted jt returns, so it needs a plain network grant, never a credential.
  qoderGrantOrigins: splitList(opt('QODER_GRANT_ORIGINS', 'https://*.qoder.sh,https://*.qoder.com')),
  qoderModelBaseUrl: opt('QODER_MODEL_BASE_URL', 'https://api.qoder.sh'),
  // Rotate the jt inside its last skew window so a turn never starts on an
  // expired token; the interval only has to be well under the 24h lifetime.
  qoderTokenSkewSeconds: Number(opt('QODER_TOKEN_SKEW_SECONDS', '21600')),
  qoderTokenIntervalSeconds: Number(opt('QODER_TOKEN_INTERVAL_SECONDS', '300')),
  modelCatalog: withQoderCatalog(parseModelCatalog(process.env.FLEET_MODELS), qoderRuntimeImage),
} as const;

export type Config = typeof config;