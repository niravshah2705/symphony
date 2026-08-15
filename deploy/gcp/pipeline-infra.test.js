'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

function variableBlock(source, name) {
  const start = source.indexOf(`variable "${name}"`);
  assert.notEqual(start, -1, `missing Terraform variable ${name}`);
  const next = source.indexOf('\nvariable "', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function resourceBlock(source, type, name) {
  const start = source.indexOf(`resource "${type}" "${name}"`);
  assert.notEqual(start, -1, `missing Terraform resource ${type}.${name}`);
  const next = source.indexOf('\nresource "', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test('pipeline rollout and deployment are fail-closed Terraform defaults', () => {
  const variables = read('deploy/gcp/terraform/variables.tf');
  assert.match(variableBlock(variables, 'pipeline_orchestrator_enabled'), /default\s*=\s*false/);
  assert.match(variableBlock(variables, 'pipeline_deployment_enabled'), /default\s*=\s*false/);
});

test('all Cloud Run services use the gen2 execution environment', () => {
  const servicesByFile = new Map([
    ['cloud_run.tf', ['gateway', 'planner', 'coder_control']],
    ['org_service.tf', ['org']],
    ['settings_service.tf', ['settings']],
    ['email_service.tf', ['email']],
    ['pipeline.tf', ['orchestrator', 'tester', 'deployer']],
    ['provisioner.tf', ['provisioner']],
    ['stream_token_service.tf', ['stream_token_broker']],
  ]);
  const expectedInventory = [...servicesByFile]
    .flatMap(([file, services]) => services.map((service) => [file, service]))
    .sort(([fileA, serviceA], [fileB, serviceB]) => `${fileA}:${serviceA}`.localeCompare(`${fileB}:${serviceB}`));
  assert.equal(expectedInventory.length, 11);

  const terraformDir = path.join(ROOT, 'deploy/gcp/terraform');
  const actualInventory = fs.readdirSync(terraformDir)
    .filter((file) => file.endsWith('.tf'))
    .flatMap((file) => {
      const source = read('deploy/gcp/terraform', file);
      return [...source.matchAll(/resource\s+"google_cloud_run_v2_service"\s+"([^"]+)"/g)]
        .map((match) => [file, match[1]]);
    })
    .sort(([fileA, serviceA], [fileB, serviceB]) => `${fileA}:${serviceA}`.localeCompare(`${fileB}:${serviceB}`));
  assert.deepEqual(actualInventory, expectedInventory, 'Cloud Run service inventory changed');

  for (const [file, expectedServices] of servicesByFile) {
    const source = read('deploy/gcp/terraform', file);
    for (const service of expectedServices) {
      assert.match(
        resourceBlock(source, 'google_cloud_run_v2_service', service),
        /^\s*execution_environment\s*=\s*"EXECUTION_ENVIRONMENT_GEN2"\s*$/m,
        `${file}: google_cloud_run_v2_service.${service} must explicitly use gen2`,
      );
    }
  }
});

test('fixed-memory gen2 Cloud Run CPU variables reject incompatible allocations', () => {
  const variables = read('deploy/gcp/terraform/variables.tf');
  const supportedCpuValues = String.raw`\[\s*"1"\s*,\s*"2"\s*\]`;

  for (const name of ['cloud_run_service_cpu', 'cloud_run_proxy_cpu']) {
    const block = variableBlock(variables, name);
    assert.match(
      block,
      new RegExp(`condition\\s*=\\s*contains\\(\\s*${supportedCpuValues}\\s*,\\s*var\\.${name}\\s*\\)`),
      `${name} must reject CPU values incompatible with fixed 512 MiB containers`,
    );
    assert.match(block, /error_message\s*=\s*"[^"]*1 or 2 vCPU[^"]*"/);
  }
});

test('skills mounts preserve configured Cloud Run service and proxy CPUs', () => {
  const cloudRun = read('deploy/gcp/terraform/cloud_run.tf');
  const variables = read('deploy/gcp/terraform/variables.tf');
  assert.doesNotMatch(
    cloudRun,
    /local\.agent_(?:service|proxy)_cpu|agent_(?:service|proxy)_cpu\s*=/,
    'skills mounts must not replace configured CPU values with local clamps',
  );

  for (const service of ['planner', 'coder_control']) {
    const resource = resourceBlock(cloudRun, 'google_cloud_run_v2_service', service);
    assert.match(resource, /cpu\s*=\s*var\.cloud_run_service_cpu/);
    assert.match(resource, /cpu\s*=\s*var\.cloud_run_proxy_cpu/);
  }

  assert.doesNotMatch(variableBlock(variables, 'skills_mount_enabled'), /\+ gen2 exec env/);
});

test('deploy workflow fails closed when an unchanged live image tag cannot be resolved', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const releaseStart = workflow.indexOf('release_tag()');
  const start = workflow.indexOf('live_tag()', releaseStart);
  const end = workflow.indexOf('resolve() {', start);
  const releaseTag = workflow.slice(releaseStart, start);
  const liveTag = workflow.slice(start, end);
  assert.ok(releaseStart >= 0 && start > releaseStart && end > start);
  assert.match(releaseTag, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(releaseTag, /Refusing non-immutable image tag/);
  assert.match(liveTag, /gcloud run services describe/);
  assert.match(liveTag, /Unable to resolve immutable live image tag/);
  assert.match(liveTag, /release_tag "\$tag"/);
  assert.doesNotMatch(liveTag, /\|\| true/);
});

test('deploy workflow does not query disabled optional Cloud Run services', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const start = workflow.indexOf('resolve_optional()');
  const end = workflow.indexOf('\n\n          {', start);
  const resolver = workflow.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(workflow, /PIPELINE_ENABLED: \$\{\{ vars\.PIPELINE_ORCHESTRATOR_ENABLED \|\| 'false' \}\}/);
  assert.match(workflow, /PROVISIONING_ENABLED: \$\{\{ vars\.PROVISIONING_ENABLED \|\| 'false' \}\}/);
  assert.match(resolver, /true\) live_tag "\$2"/);
  assert.match(resolver, /false\)[\s\S]*release_tag "\$GITHUB_SHA" "disabled optional service \$2"/);
  assert.match(resolver, /Invalid enablement flag for optional service/);
  assert.match(workflow, /write_tag orchestrator resolve_optional orchestrator pipeline-orchestrator "\$PIPELINE_ENABLED"/);
  assert.match(workflow, /write_tag tester resolve_optional tester pipeline-tester "\$PIPELINE_ENABLED"/);
  assert.match(workflow, /write_tag deployer resolve_optional deployer pipeline-deployer "\$PIPELINE_ENABLED"/);
  assert.match(workflow, /write_tag provisioner resolve_optional provisioner provisioner "\$PROVISIONING_ENABLED"/);
  assert.match(workflow, /-var="provisioning_enabled=\$\{\{ vars\.PROVISIONING_ENABLED \|\| 'false' \}\}"/);

  for (const [id, service] of [
    ['gateway', 'gateway'],
    ['planner', 'planner'],
    ['coder', 'coder-control'],
    ['org', 'org-service'],
    ['settings', 'settings-service'],
    ['email', 'email-service'],
  ]) {
    assert.match(workflow, new RegExp(`write_tag ${id} resolve ${id} ${service}`));
  }
});

test('optional image resolver uses a SHA placeholder only while disabled', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const start = workflow.indexOf('release_tag()');
  const end = workflow.indexOf('\n\n          {', start);
  const functions = workflow.slice(start, end);
  const sha = 'a'.repeat(40);
  const prefix = `
set -euo pipefail
GITHUB_SHA=${sha}
PROJECT=test-project
REGION=test-region
${functions}
`;

  const disabled = spawnSync('bash', ['-c', `${prefix}
built() { return 1; }
gcloud() { echo "disabled optional service was queried" >&2; return 70; }
resolve_optional orchestrator pipeline-orchestrator false
`], { encoding: 'utf8' });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(disabled.stdout.trim(), sha);

  const built = spawnSync('bash', ['-c', `${prefix}
built() { return 0; }
gcloud() { echo "rebuilt optional service was queried" >&2; return 71; }
resolve_optional orchestrator pipeline-orchestrator true
`], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  assert.equal(built.stdout.trim(), sha);

  const liveSha = 'b'.repeat(40);
  const enabled = spawnSync('bash', ['-c', `${prefix}
built() { return 1; }
gcloud() { printf '%s\\n' "test.pkg/pipeline-orchestrator:${liveSha}"; }
resolve_optional orchestrator pipeline-orchestrator true
`], { encoding: 'utf8' });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(enabled.stdout.trim(), liveSha);

  const invalid = spawnSync('bash', ['-c', `${prefix}
built() { return 1; }
gcloud() { return 72; }
resolve_optional orchestrator pipeline-orchestrator unexpected
`], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid enablement flag for optional service/);
});

test('required image resolution failure makes the tag output step fail', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const start = workflow.indexOf('release_tag()');
  const end = workflow.indexOf('\n\n          {', start);
  const functions = workflow.slice(start, end);
  const failed = spawnSync('bash', ['-c', `
set -euo pipefail
GITHUB_SHA=${'a'.repeat(40)}
PROJECT=test-project
REGION=test-region
${functions}
built() { return 1; }
gcloud() { echo "required live service lookup failed" >&2; return 72; }
write_tag gateway resolve gateway gateway
echo "resolver failure was masked" >&2
`], { encoding: 'utf8' });

  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Unable to resolve immutable live image tag for gateway/);
  assert.match(failed.stderr, /Unable to resolve image tag output gateway/);
  assert.doesNotMatch(failed.stderr, /resolver failure was masked/);
  assert.equal(failed.stdout, '');
});

test('pipeline topology enforces dedicated topics and brokered agent egress', () => {
  const pipeline = read('deploy/gcp/terraform/pipeline.tf');
  const cloudRun = read('deploy/gcp/terraform/cloud_run.tf');
  const variables = read('deploy/gcp/terraform/variables.tf');
  assert.match(pipeline, /check "pipeline_topics_are_dedicated"/);
  assert.match(pipeline, /var\.planner_topic/);
  assert.match(pipeline, /var\.coder_topic/);
  for (const stage of ['plan', 'code', 'test', 'deploy', 'results']) {
    assert.match(pipeline, new RegExp(`google_pubsub_topic" "pipeline_${stage}"`));
  }
  for (const stage of ['plan', 'code', 'test', 'deploy']) {
    assert.match(variables, new RegExp(`variable "pipeline_${stage}_results_topic"`));
    assert.match(pipeline, new RegExp(`${stage}\\s*=\\s*var\\.pipeline_${stage}_results_topic`));
    assert.match(
      pipeline,
      new RegExp(`push_endpoint\\s*=\\s*"\\$\\{local\\.orchestrator_url\\}/pubsub/pipeline-stage-results/\\$\\{each\\.key\\}"`),
    );
  }
  assert.match(pipeline, /resource "google_pubsub_topic_iam_member" "pipeline_result_publish"/);
  assert.match(pipeline, /topic\s*=\s*google_pubsub_topic\.pipeline_results\[each\.key\]\.name/);
  assert.match(pipeline, /plan\s*=\s*google_service_account\.planner\.email/);
  assert.match(pipeline, /code\s*=\s*google_service_account\.coder\.email/);
  assert.match(pipeline, /test\s*=\s*google_service_account\.tester\[0\]\.email/);
  assert.match(pipeline, /deploy\s*=\s*google_service_account\.deployer\[0\]\.email/);
  assert.doesNotMatch(`${pipeline}\n${cloudRun}`, /PIPELINE_RESULTS_TOPIC\s*=/);
  assert.match(cloudRun, /PUBSUB_PIPELINE_PLAN_RESULTS_TOPIC\s*=\s*var\.pipeline_plan_results_topic/);
  assert.match(cloudRun, /PUBSUB_PIPELINE_CODE_RESULTS_TOPIC\s*=\s*var\.pipeline_code_results_topic/);
  assert.match(pipeline, /PUBSUB_PIPELINE_TEST_RESULTS_TOPIC\s*=\s*var\.pipeline_test_results_topic/);
  assert.match(pipeline, /PUBSUB_PIPELINE_DEPLOY_RESULTS_TOPIC\s*=\s*var\.pipeline_deploy_results_topic/);
  assert.equal((pipeline.match(/PIPELINE_STAGE_STORE_BACKEND\s*=\s*"firestore"/g) || []).length, 2);
  assert.equal((cloudRun.match(/PIPELINE_STAGE_STORE_BACKEND\s*=\s*"firestore"/g) || []).length, 2);
  assert.match(pipeline, /check "pipeline_agent_egress_is_brokered"/);
  assert.match(pipeline, /trimspace\(nonsensitive\(var\.internal_api_token\)\) != ""/);
  assert.doesNotMatch(variables, /variable "egress_proxy_enabled"/);
  assert.match(cloudRun, /!local\.pipeline_on \|\| var\.min_instances <= 1/);
  assert.equal(
    (cloudRun.match(/max_instance_count = local\.pipeline_on \? 1 : var\.max_instances/g) || []).length,
    2,
  );

  for (const service of ['tester', 'deployer']) {
    const start = pipeline.indexOf(`resource "google_cloud_run_v2_service" "${service}"`);
    const end = pipeline.indexOf('\nresource "google_cloud_run_v2_service"', start + 1);
    const resource = pipeline.slice(start, end === -1 ? pipeline.length : end);
    const appEnd = resource.indexOf('name  = "egress-proxy"');
    assert.ok(appEnd > 0, `${service} must include the egress-proxy sidecar`);
    assert.doesNotMatch(resource.slice(0, appEnd), /secret_key_ref/);
    assert.match(resource, /local\.proxy_plain_env/);
    assert.match(resource, /depends_on\s*=\s*\["egress-proxy"\]/);
  }
});

test('stream-token broker owns the signing secret behind private IAM', () => {
  const cloudRun = read('deploy/gcp/terraform/cloud_run.tf');
  const brokerSource = read('deploy/gcp/terraform/stream_token_service.tf');
  const pipeline = read('deploy/gcp/terraform/pipeline.tf');
  const provisioner = read('deploy/gcp/terraform/provisioner.tf');
  const iam = read('deploy/gcp/terraform/iam.tf');
  const variables = read('deploy/gcp/terraform/variables.tf');
  const outputs = read('deploy/gcp/terraform/outputs.tf');

  const gateway = resourceBlock(cloudRun, 'google_cloud_run_v2_service', 'gateway');
  const broker = resourceBlock(brokerSource, 'google_cloud_run_v2_service', 'stream_token_broker');
  const brokerSecret = resourceBlock(iam, 'google_secret_manager_secret_iam_member', 'stream_token_broker');
  const legacyGatewaySecret = resourceBlock(iam, 'google_secret_manager_secret_iam_member', 'gateway_stream_token_legacy');
  const brokerInvoker = resourceBlock(iam, 'google_cloud_run_v2_service_iam_member', 'gateway_invokes_stream_token_broker');

  assert.match(cloudRun, /STREAM_TOKEN_SERVICE_URL\s*=\s*google_cloud_run_v2_service\.stream_token_broker\.uri/);
  assert.match(provisioner, /STREAM_TOKEN_SERVICE_URL\s*=\s*google_cloud_run_v2_service\.stream_token_broker\.uri/);
  assert.doesNotMatch(gateway, /STREAM_TOKEN_SECRET|stream-token-proxy|127\.0\.0\.1:4030/);
  assert.match(gateway, /google_cloud_run_v2_service\.stream_token_broker/);
  assert.match(gateway, /google_cloud_run_v2_service_iam_member\.gateway_invokes_stream_token_broker/);

  assert.match(broker, /service_account\s*=\s*google_service_account\.stream_token_broker\.email/);
  assert.match(broker, /ingress\s*=\s*var\.internal_ingress/);
  assert.match(broker, /image\s*=\s*local\.proxy_image/);
  assert.match(broker, /command\s*=\s*\["node"\]/);
  assert.match(broker, /args\s*=\s*\["services\/proxy\/src\/stream-token-server\.js"\]/);
  assert.match(broker, /name\s*=\s*"STREAM_TOKEN_BIND_HOST"\s+value\s*=\s*"0\.0\.0\.0"/);
  assert.match(broker, /name\s*=\s*"STREAM_TOKEN_SECRET"/);
  assert.doesNotMatch(broker, /PROXY_CAPABILITIES|egress-proxy/);
  assert.doesNotMatch(gateway, /STREAM_TOKEN_BIND_HOST/);
  const brokerMinInstances = variableBlock(variables, 'stream_token_min_instances');
  assert.match(brokerMinInstances, /default\s*=\s*1/);
  assert.match(
    brokerMinInstances,
    /condition\s*=\s*var\.stream_token_min_instances\s*>=\s*0\s*&&\s*floor\(var\.stream_token_min_instances\)\s*==\s*var\.stream_token_min_instances/,
  );
  assert.match(broker, /min_instance_count\s*=\s*var\.stream_token_min_instances/);
  assert.match(broker, /condition\s*=\s*var\.stream_token_min_instances\s*<=\s*var\.max_instances/);

  assert.match(brokerSecret, /role\s*=\s*"roles\/secretmanager\.secretAccessor"/);
  assert.match(brokerSecret, /member\s*=\s*"serviceAccount:\$\{google_service_account\.stream_token_broker\.email\}"/);
  assert.match(
    variableBlock(variables, 'stream_token_legacy_gateway_secret_access'),
    /default\s*=\s*true/,
    'the first migration apply must preserve legacy tenant sidecars',
  );
  assert.match(
    legacyGatewaySecret,
    /count\s*=\s*var\.stream_token_legacy_gateway_secret_access\s*\?\s*1\s*:\s*0/,
    'setting the migration gate false must remove the gateway secret binding',
  );
  assert.match(legacyGatewaySecret, /member\s*=\s*"serviceAccount:\$\{google_service_account\.gateway\.email\}"/);
  assert.match(iam, /to\s*=\s*google_secret_manager_secret_iam_member\.gateway_stream_token_legacy\[0\]/);
  const streamSecretAccessors = [...iam.matchAll(
    /resource "google_secret_manager_secret_iam_member" "([^"]+)" \{([\s\S]*?)(?=\nresource "|\n# ---|$)/g,
  )]
    .filter(([, , body]) => /secret_id\s*=\s*google_secret_manager_secret\.stream_token_secret\.secret_id/.test(body))
    .map(([, name]) => name)
    .sort();
  assert.deepEqual(
    streamSecretAccessors,
    ['gateway_stream_token_legacy', 'stream_token_broker'],
    'the completed false-gate state must leave only the broker accessor',
  );
  assert.match(outputs, /output "stream_token_legacy_gateway_secret_access_enabled"/);
  assert.match(outputs, /value\s*=\s*var\.stream_token_legacy_gateway_secret_access/);
  assert.match(brokerInvoker, /role\s*=\s*"roles\/run\.invoker"/);
  assert.match(brokerInvoker, /member\s*=\s*"serviceAccount:\$\{google_service_account\.gateway\.email\}"/);
  assert.doesNotMatch(brokerInvoker, /allUsers/);
  const brokerIamBindings = [...iam.matchAll(
    /resource "google_cloud_run_v2_service_iam_member" "([^"]+)" \{([\s\S]*?)(?=\nresource "|\n# ---|$)/g,
  )].filter(([, , body]) => /google_cloud_run_v2_service\.stream_token_broker\.name/.test(body));
  assert.equal(brokerIamBindings.length, 1, 'the broker must have one explicit invoker binding');
  assert.doesNotMatch(brokerIamBindings[0][2], /allUsers/, 'the broker must never be publicly invokable');

  for (const service of ['planner', 'coder_control']) {
    const resource = resourceBlock(cloudRun, 'google_cloud_run_v2_service', service);
    const proxy = resource.indexOf('name  = "egress-proxy"');
    assert.ok(proxy > 0);
    assert.doesNotMatch(resource.slice(0, proxy), /secret_key_ref|INTERNAL_API_TOKEN/);
    assert.match(resource.slice(proxy), /name\s*=\s*"INTERNAL_API_TOKEN"\s+value\s*=\s*var\.internal_api_token/);
  }

  assert.doesNotMatch(`${cloudRun}\n${pipeline}`, /egress_proxy_enabled/);
  assert.doesNotMatch(iam, /(?:gateway|planner|coder)[^\n]*linear|linear[^\n]*(?:gateway|planner|coder)/i);
  assert.doesNotMatch(`${cloudRun}\n${pipeline}`, /proxy_internal_token/);
});

test('proxy artifact retention preserves a multi-revision broker rollback window', () => {
  const variables = read('deploy/gcp/terraform/variables.tf');
  const artifactRegistry = read('deploy/gcp/terraform/artifact_registry.tf');
  assert.match(variableBlock(variables, 'artifact_retention_count'), /default\s*=\s*[3-9][0-9]*/);
  assert.match(artifactRegistry, /keep_count\s*=\s*var\.artifact_retention_count/);
});

test('OpenSWE upstream is trusted proxy-only deployment configuration', () => {
  const cloudRun = read('deploy/gcp/terraform/cloud_run.tf');
  const variables = read('deploy/gcp/terraform/variables.tf');
  const block = variableBlock(variables, 'openswe_proxy_upstream');
  assert.match(block, /default\s*=\s*""/);
  assert.match(block, /without credentials, query, or fragment/);

  const egressEnvStart = cloudRun.indexOf('egress_env =');
  const proxyEnvStart = cloudRun.indexOf('proxy_plain_env =', egressEnvStart);
  const plannerEnvStart = cloudRun.indexOf('planner_env =', proxyEnvStart);
  assert.ok(egressEnvStart >= 0 && proxyEnvStart > egressEnvStart && plannerEnvStart > proxyEnvStart);
  assert.doesNotMatch(cloudRun.slice(egressEnvStart, proxyEnvStart), /OPENSWE_(?:URL|PROXY_UPSTREAM)/);
  assert.match(
    cloudRun.slice(proxyEnvStart, plannerEnvStart),
    /OPENSWE_PROXY_UPSTREAM\s*=\s*trimspace\(var\.openswe_proxy_upstream\)/,
  );
});

test('orchestrator image remains free of the heavy shared agent SDK workspace', () => {
  const dockerfile = read('deploy/gcp/Dockerfile.orchestrator');
  assert.match(dockerfile, /COPY packages\/shared-core\//);
  assert.doesNotMatch(dockerfile, /COPY packages\/shared\//);
  assert.doesNotMatch(dockerfile, /COPY packages\/ \./);
  assert.match(dockerfile, /--workspace=@ai-fleet\/orchestrator/);
});

test('coder image installs the seccomp launcher for model-controlled commands', () => {
  const dockerfile = read('deploy/gcp/Dockerfile.coder');
  const harness = read('packages/shared/src/agent/harnesses/deepagent.js');
  assert.match(dockerfile, /network-sandbox\.c/);
  assert.match(dockerfile, /-lseccomp/);
  assert.match(dockerfile, /apk add --no-cache git openssh-client ca-certificates bash libseccomp/);
  assert.match(dockerfile, /\/usr\/local\/bin\/ai-fleet-network-sandbox/);
  assert.match(harness, /NODE_ENV[\s\S]*production/);
  assert.match(harness, /EGRESS_PROXY_URL/);
  assert.match(harness, /exec[\s\S]*quoteShellArg\(launcher\)[\s\S]*quoteShellArg\(command\)/);
});

test('tester image installs the capability-free network sandbox for repository commands', () => {
  const dockerfile = read('deploy/gcp/Dockerfile.tester');
  const runtime = read('packages/shared/src/agent/pipeline-stage-runtime.js');
  assert.match(dockerfile, /network-sandbox\.c/);
  assert.match(dockerfile, /-lseccomp/);
  assert.match(dockerfile, /apk add --no-cache git openssh-client ca-certificates bash libseccomp/);
  assert.match(dockerfile, /\/usr\/local\/bin\/ai-fleet-network-sandbox/);
  assert.doesNotMatch(dockerfile, /COPY --from=builder --chown=node:node \/app \/app/);
  assert.match(runtime, /isolateNetwork: process\.env\.NODE_ENV === 'production'/);
});

test('direct settings operator access is IAM-gated and never public', () => {
  const settings = read('deploy/gcp/terraform/settings_service.tf');
  assert.match(settings, /resource "google_cloud_run_v2_service_iam_member" "operator_invokes_settings"/);
  assert.match(settings, /trimspace\(var\.settings_operator_invoker\)/);
  assert.doesNotMatch(settings, /member\s*=\s*"allUsers"/);
});

test('tenant vault token derivation root is limited to settings and provisioner', () => {
  const settings = read('deploy/gcp/terraform/settings_service.tf');
  const provisioner = read('deploy/gcp/terraform/provisioner.tf');
  const cloudRun = read('deploy/gcp/terraform/cloud_run.tf');
  const pipeline = read('deploy/gcp/terraform/pipeline.tf');
  assert.match(settings, /resource "google_secret_manager_secret" "org_s2s_signing_key"/);
  assert.match(settings, /member\s*=\s*"serviceAccount:\$\{google_service_account\.settings\.email\}"/);
  assert.match(provisioner, /provisioner_org_s2s_signing_key/);
  assert.doesNotMatch(cloudRun, /ORG_S2S_SIGNING_KEY/);
  assert.doesNotMatch(pipeline, /ORG_S2S_SIGNING_KEY/);
});

test('orchestrator can consume run-bound deployment approvals from settings', () => {
  const pipeline = read('deploy/gcp/terraform/pipeline.tf');
  const start = pipeline.indexOf('resource "google_cloud_run_v2_service" "orchestrator"');
  const end = pipeline.indexOf('\nresource "google_cloud_run_v2_service"', start + 1);
  const resource = pipeline.slice(start, end);
  assert.match(pipeline, /SETTINGS_URL\s*=\s*local\.settings_url/);
  assert.match(resource, /name\s*=\s*"INTERNAL_API_TOKEN"/);
  assert.match(pipeline, /pipeline_proxy_invokes_settings/);
  assert.doesNotMatch(pipeline, /pipeline_proxy_internal_token/);
});
