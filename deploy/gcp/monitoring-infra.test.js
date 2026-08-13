'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const dockerfile = read('deploy/gcp/Dockerfile.alloy');
const config = read('deploy/gcp/alloy/config.alloy');
const terraform = read('deploy/gcp/terraform/monitoring.tf');
const variables = read('deploy/gcp/terraform/variables.tf');
const deployWorkflow = read('.github/workflows/deploy.yml');
const checksWorkflow = read('.github/workflows/checks.yml');
const cloudBuild = read('cloudbuild.yaml');
const deployScript = read('deploy/gcp/deploy.sh');
const bootstrapScript = read('deploy/gcp/bootstrap.sh');

function block(source, kind, name) {
  const marker = `${kind} "${name}"`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${marker}`);

  const open = source.indexOf('{', start + marker.length);
  assert.notEqual(open, -1, `missing opening brace for ${marker}`);

  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`unterminated ${marker}`);
}

test('Alloy image is immutable, config-only, and preserves the upstream entrypoint', () => {
  assert.match(dockerfile, /grafana\/alloy:v1\.18\.1@sha256:[0-9a-f]{64}/);
  assert.match(dockerfile, /COPY --chmod=0444 deploy\/gcp\/alloy\/config\.alloy \/etc\/alloy\/config\.alloy/);
  assert.match(dockerfile, /^USER alloy$/m);
  assert.match(dockerfile, /EXPOSE 8080/);
  assert.doesNotMatch(dockerfile, /\b(?:ENTRYPOINT|CMD)\b\s*\[/);
  assert.doesNotMatch(dockerfile, /GRAFANA_CLOUD_TOKEN\s*=/);
});

test('all runtime configuration and both backends use environment-only credentials', () => {
  for (const name of [
    'GCP_PROJECT_ID',
    'GCP_REGION',
    'DEPLOYMENT_ENVIRONMENT',
    'GRAFANA_METRICS_URL',
    'GRAFANA_METRICS_USERNAME',
    'GRAFANA_LOKI_URL',
    'GRAFANA_LOKI_USERNAME',
    'GRAFANA_CLOUD_TOKEN',
    'GRAFANA_LOG_SUBSCRIPTION',
    'GRAFANA_CLOUD_RUN_SERVICE_REGEX',
    'GRAFANA_CLOUD_RUN_JOB_REGEX',
    'GRAFANA_PUBSUB_RESOURCE_REGEX',
    'GRAFANA_GCS_BUCKET_REGEX',
    'GRAFANA_ARTIFACT_REPOSITORY_REGEX',
  ]) {
    assert.match(config, new RegExp(`sys\\.env\\("${name}"\\)`), `${name} must be runtime-injected`);
  }

  const metrics = block(config, 'prometheus.remote_write', 'grafana_cloud');
  const logs = block(config, 'loki.write', 'grafana_cloud');
  assert.match(metrics, /url\s*=\s*sys\.env\("GRAFANA_METRICS_URL"\)/);
  assert.match(metrics, /username\s*=\s*sys\.env\("GRAFANA_METRICS_USERNAME"\)/);
  assert.match(metrics, /password\s*=\s*sys\.env\("GRAFANA_CLOUD_TOKEN"\)/);
  assert.match(metrics, /queue_config\s*\{[\s\S]*retry_on_http_429\s*=\s*true/);
  assert.match(logs, /url\s*=\s*sys\.env\("GRAFANA_LOKI_URL"\)/);
  assert.match(logs, /username\s*=\s*sys\.env\("GRAFANA_LOKI_USERNAME"\)/);
  assert.match(logs, /password\s*=\s*sys\.env\("GRAFANA_CLOUD_TOKEN"\)/);
  assert.doesNotMatch(config, /https:\/\/prometheus-prod-|https:\/\/logs-prod-/);
});

test('native metric collection is project-bound and allowlisted by resource', () => {
  const exporters = [...config.matchAll(/prometheus\.exporter\.gcp "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(exporters, [
    'cloud_run_services',
    'cloud_run_jobs',
    'pubsub_topics',
    'pubsub_subscriptions',
    'firestore',
    'gcs',
    'artifact_registry',
    'firebase_hosting',
    'identity_platform',
    'service_runtime',
  ]);

  for (const name of exporters) {
    const exporter = block(config, 'prometheus.exporter.gcp', name);
    assert.match(exporter, /project_ids\s*=\s*\[sys\.env\("GCP_PROJECT_ID"\)\]/);
    assert.match(exporter, /drop_delegated_projects\s*=\s*true/);
    assert.match(exporter, /metrics_prefixes\s*=/);
  }

  assert.match(config, /run\.googleapis\.com\/.*GRAFANA_CLOUD_RUN_SERVICE_REGEX/s);
  assert.match(config, /run\.googleapis\.com\/.*GRAFANA_CLOUD_RUN_JOB_REGEX/s);
  assert.match(config, /pubsub\.googleapis\.com\/topic.*GRAFANA_PUBSUB_RESOURCE_REGEX/s);
  assert.match(config, /pubsub\.googleapis\.com\/subscription.*GRAFANA_PUBSUB_RESOURCE_REGEX/s);
  assert.match(config, /firestore\.googleapis\.com\/.*database_id=\\"\(default\)\\"/s);
  assert.match(config, /storage\.googleapis\.com\/.*GRAFANA_GCS_BUCKET_REGEX/s);
  assert.match(config, /artifactregistry\.googleapis\.com\/repository.*GRAFANA_ARTIFACT_REPOSITORY_REGEX/s);
  assert.match(config, /firebasehosting\.googleapis\.com\//);
  assert.match(config, /identitytoolkit\.googleapis\.com\//);
  assert.match(config, /serviceruntime\.googleapis\.com\/api/);
});

test('metrics are labeled conservatively and Alloy self-health is pushed', () => {
  const relabel = block(config, 'prometheus.relabel', 'gcp_native');
  assert.match(relabel, /target_label\s*=\s*"component"/);
  assert.match(relabel, /target_label\s*=\s*"tenancy"/);
  assert.match(relabel, /replacement\s*=\s*"dedicated"/);
  assert.match(relabel, /action\s*=\s*"labeldrop"/);
  assert.match(relabel, /revision.*request.*user.*credential/s);
  assert.match(relabel, /\(\?:id\|name\)/);

  const self = block(config, 'prometheus.scrape', 'alloy_self');
  assert.match(self, /"__address__"\s*=\s*"127\.0\.0\.1:8080"/);
  assert.match(self, /job_name\s*=\s*"integrations\/grafana-alloy"/);
  assert.match(self, /metrics_path\s*=\s*"\/metrics"/);
  assert.match(self, /component\s*=\s*"grafana-alloy"/);
  assert.match(self, /tenancy\s*=\s*"shared"/);
});

test('GCP logs use durable pull delivery, original timestamps, and bounded labels and flow', () => {
  const source = block(config, 'loki.source.gcplog', 'gcp_cloud_run');
  assert.match(source, /project_id\s*=\s*sys\.env\("GCP_PROJECT_ID"\)/);
  assert.match(source, /subscription\s*=\s*sys\.env\("GRAFANA_LOG_SUBSCRIPTION"\)/);
  assert.match(source, /use_incoming_timestamp\s*=\s*true/);
  assert.match(source, /max_outstanding_bytes\s*=\s*"128MiB"/);
  assert.match(source, /max_outstanding_messages\s*=\s*500/);
  assert.match(source, /relabel_rules\s*=\s*discovery\.relabel\.gcp_logs\.rules/);
  assert.match(source, /forward_to\s*=\s*\[loki\.write\.grafana_cloud\.receiver\]/);

  const relabel = block(config, 'discovery.relabel', 'gcp_logs');
  for (const label of ['logname', 'resource_type', 'location', 'service_name', 'job_name', 'container', 'severity']) {
    assert.match(relabel, new RegExp(`target_label\\s*=\\s*"${label}"`));
  }
  assert.match(relabel, /action\s*=\s*"labelkeep"/);
  assert.doesNotMatch(relabel, /target_label\s*=\s*"(?:revision_name|execution_name|task_index|request_id|user_id|org_id)"/);

  const logs = block(config, 'loki.write', 'grafana_cloud');
  assert.match(logs, /max_streams\s*=\s*5000/);
  assert.match(logs, /batch_size\s*=\s*"1MiB"/);
  assert.match(logs, /retry_on_http_429\s*=\s*true/);
});

test('Terraform keeps the empty token container bootstrap-safe and gates every consumer', () => {
  const secret = block(
    terraform,
    'resource "google_secret_manager_secret"',
    'grafana_cloud_access_token',
  );
  assert.doesNotMatch(secret, /\bcount\s*=/);
  assert.doesNotMatch(terraform, /resource "google_secret_manager_secret_version"/);
  assert.match(variables, /variable "grafana_monitoring_enabled"[\s\S]*?default\s*=\s*false/);

  for (const [type, name] of [
    ['google_cloud_run_v2_service', 'grafana_alloy'],
    ['google_logging_project_sink', 'grafana_cloud_run'],
    ['google_pubsub_topic', 'grafana_cloud_logs'],
    ['google_pubsub_subscription', 'grafana_cloud_logs'],
    ['google_service_account', 'grafana_alloy'],
  ]) {
    const resource = block(terraform, `resource "${type}"`, name);
    assert.match(resource, /count\s*=\s*var\.grafana_monitoring_enabled\s*\?\s*1\s*:\s*0/);
  }
});

test('the central collector is private, singleton, always-CPU, and the only token consumer', () => {
  const service = block(terraform, 'resource "google_cloud_run_v2_service"', 'grafana_alloy');
  assert.match(service, /ingress\s*=\s*"INGRESS_TRAFFIC_INTERNAL_ONLY"/);
  assert.match(service, /min_instance_count\s*=\s*1/);
  assert.match(service, /max_instance_count\s*=\s*1/);
  assert.match(service, /cpu_idle\s*=\s*false/);
  assert.match(service, /path\s*=\s*"\/-\/ready"/);
  assert.match(service, /secret\s*=\s*google_secret_manager_secret\.grafana_cloud_access_token\.secret_id/);
  assert.match(service, /version\s*=\s*trimspace\(var\.grafana_cloud_token_version\)/);
  assert.doesNotMatch(terraform, /member\s*=\s*"allUsers"/);

  const accessor = block(
    terraform,
    'resource "google_secret_manager_secret_iam_member"',
    'grafana_alloy_token_accessor',
  );
  assert.match(accessor, /roles\/secretmanager\.secretAccessor/);
  assert.match(accessor, /google_service_account\.grafana_alloy\[0\]\.email/);

  assert.match(
    variables,
    /variable "managed_provider_secrets"[\s\S]*?!contains\(values\(var\.managed_provider_secrets\), "grafana-cloud-access-token"\)/,
  );
  assert.match(
    variables,
    /variable "extra_secret_ids"[\s\S]*?!contains\(var\.extra_secret_ids, "grafana-cloud-access-token"\)/,
  );
});

test('every deployment path stages the token secret and propagates monitoring inputs', () => {
  for (const source of [deployWorkflow, cloudBuild, deployScript]) {
    for (const name of [
      'grafana_monitoring_enabled',
      'grafana_metrics_remote_write_url',
      'grafana_metrics_username',
      'grafana_loki_push_url',
      'grafana_loki_username',
      'grafana_cloud_token_version',
      'alloy_image_tag',
    ]) {
      assert.match(source.toLowerCase(), new RegExp(name), `missing ${name} deployment wiring`);
    }
    assert.match(source, /grafana-cloud-access-token/);
    assert.match(source, /Dockerfile\.alloy/);
  }

  assert.match(bootstrapScript, /roles\/logging\.configWriter/);
  assert.match(bootstrapScript, /google_secret_manager_secret\.grafana_cloud_access_token/);
  assert.match(deployScript, /unset GRAFANA_CLOUD_TOKEN/);
  assert.doesNotMatch(deployWorkflow, /secrets\.GRAFANA_CLOUD_TOKEN/);
  assert.doesNotMatch(cloudBuild, /^\s*_GRAFANA_CLOUD_TOKEN:/m);
});

test('CI performs real Terraform and Alloy validation', () => {
  assert.match(checksWorkflow, /terraform fmt -check -recursive deploy\/gcp\/terraform/);
  assert.match(checksWorkflow, /terraform init -backend=false/);
  assert.match(checksWorkflow, /terraform validate/);
  assert.match(checksWorkflow, /docker build -f deploy\/gcp\/Dockerfile\.alloy/);
  assert.match(checksWorkflow, /ai-fleet-alloy:check validate \/etc\/alloy\/config\.alloy/);
});
