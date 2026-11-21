// Runtime configuration. Every credential arrives via environment (mounted from
// k8s Secrets in deploy/bff); nothing secret is baked into the repo. Defaults
// point at the in-cluster service DNS of the kind cluster `flexprice-local`.

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

function opt(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
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
  defaultOrgBudgetUsd: Number(opt('DEFAULT_ORG_BUDGET_USD', '50')),
  defaultProjectBudgetUsd: Number(opt('DEFAULT_PROJECT_BUDGET_USD', '20')),
  budgetDuration: opt('DEFAULT_BUDGET_DURATION', '30d'),
  sweeperIntervalSeconds: Number(opt('SWEEPER_INTERVAL_SECONDS', '60')),
} as const;

export type Config = typeof config;