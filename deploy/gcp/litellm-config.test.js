'use strict';

// Structural invariants for the self-hosted LiteLLM gateway: the model-name
// contract that decideLlm depends on, the no-secret-literals rule for the
// mirrored config, and the single-instance / single-ingress shape Terraform must
// keep while Postgres and Redis live on ephemeral emptyDir.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const litellmConfig = YAML.parse(read('deploy', 'litellm', 'config.yaml'));
const litellmTf = read('deploy', 'gcp', 'terraform', 'litellm.tf');
const { EGRESS_ROUTES } = require('@ai-fleet/shared-core/egress');
const mp = require('@ai-fleet/shared/agent/model-presets');

// Every model id `enforceLlmModel` can hand a claude/codex harness: the `model`
// field of each catalog preset for those providers.
const harnessModelIds = mp.publicCatalog().presets
  .filter((preset) => preset.provider === 'claude' || preset.provider === 'codex')
  .map((preset) => preset.model);

const declaredModelNames = litellmConfig.model_list.map((entry) => entry.model_name);

test('every claude/codex catalog model has a bare model_name in LiteLLM config', () => {
  // A litellm descriptor keeps the BARE model id on the wire (wireModelId only
  // prefixes for langsmith) and LiteLLM matches model_name verbatim, so a missing
  // entry is a 403 key_model_access_denied on that opted-in run — not a fallback
  // to direct egress.
  const missing = harnessModelIds.filter((model) => !declaredModelNames.includes(model));
  assert.deepEqual(missing, [], `config.yaml is missing model_name entries for: ${missing.join(', ')}`);
});

test('LiteLLM model_name entries are bare and route to a provider-prefixed model', () => {
  for (const entry of litellmConfig.model_list) {
    assert.doesNotMatch(entry.model_name, /\//, `${entry.model_name} must be the bare id`);
    assert.match(
      entry.litellm_params.model,
      /^(anthropic|openai)\//,
      `${entry.model_name} must map to a provider-qualified upstream model`
    );
    assert.equal(
      entry.litellm_params.model.split('/')[1],
      entry.model_name,
      `${entry.model_name} must map to its own provider model`
    );
    assert.match(
      entry.litellm_params.api_key,
      /^os\.environ\/(ANTHROPIC_API_KEY|OPENAI_API_KEY)$/,
      `${entry.model_name} must read its provider key from the environment, never a literal`
    );
  }
});

test('config.yaml carries no secret values and no DB/master-key wiring', () => {
  // Secrets arrive via secret_key_ref env (litellm.tf); anything in this file
  // lands in git and in the mirrored image.
  const source = read('deploy', 'litellm', 'config.yaml');
  assert.doesNotMatch(source, /\b(sk-ant-|lsv2_|proj_[A-Za-z0-9]{20,}|ghp_)[A-Za-z0-9_-]/);
  assert.equal(litellmConfig.general_settings.master_key, undefined);
  assert.equal(litellmConfig.general_settings.database_url, undefined);
  assert.ok(
    !/LITELLM_(MASTER|SALT)_KEY/.test(source.replace(/#.*/g, '')),
    'key material must stay in Terraform env, not this file'
  );
});

test('PoC privacy default: message bodies are redacted, agent timeouts stay long', () => {
  // Prompts contain model-generated code and customer secrets
  // (services/proxy/CLAUDE.md invariant 4). request_timeout must not inherit the
  // upstream doc example's 10s — agent turns stream for minutes.
  assert.equal(litellmConfig.litellm_settings.turn_off_message_logging, true);
  assert.ok(litellmConfig.litellm_settings.request_timeout >= 300);
  assert.doesNotMatch(JSON.stringify(litellmConfig.callbacks || []), /gcs_bucket|gcs_pubsub/,
    'GCS log sinks are Enterprise-license gated and unavailable here');
});

test('/litellm is an env-pinned target route, never a static upstream', () => {
  const route = EGRESS_ROUTES.litellm;
  // resolveUpstream returns route.upstream RAW, bypassing normalizeTrustedUpstream
  // — so a static upstream would skip the SSRF validation this route needs.
  assert.equal(route.target, 'litellm');
  assert.equal(route.upstream, undefined);
  assert.equal(route.auth, 'apiKey');
  assert.equal(route.secretKey, 'litellmApiKey');
  // optionalCredential would make the route anonymous (fail-open). Never here.
  assert.equal(route.optionalCredential, undefined);
});

test('litellm.tf keeps the ephemeral-state shape honest', () => {
  const containerNames = [...litellmTf.matchAll(/^\s+name\s+= "(app|postgres|redis)"$/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(containerNames)].sort(), ['app', 'postgres', 'redis']);

  // Only the ingress container may declare ports; a second one would expose
  // Postgres or Redis to the network.
  const portBlocks = [...litellmTf.matchAll(/container_port\s+=\s+(\d+)/g)].map((m) => m[1]);
  assert.deepEqual(portBlocks, ['4000'], 'exactly one container may receive ingress');

  // N instances would mean N independent Postgres and N Redis — split-brain keys
  // and spend logs. This is structural, not a preference.
  assert.match(litellmTf, /max_instance_count\s+=\s+1/, 'max_instance_count must stay pinned to 1');
  assert.match(litellmTf, /empty_dir\s+/, 'state must ride on emptyDir, not a persistent volume');

  // Salt + master guard what is encrypted in the DB; recreating them orphans it.
  const saltBlock = litellmTf.slice(
    litellmTf.indexOf('resource "google_secret_manager_secret" "litellm_salt_key"'),
    litellmTf.indexOf('resource "google_secret_manager_secret" "litellm_postgres_password"')
  );
  assert.match(saltBlock, /prevent_destroy\s+=\s+true/);
  const masterBlock = litellmTf.slice(
    litellmTf.indexOf('resource "google_secret_manager_secret" "litellm_master_key"'),
    litellmTf.indexOf('resource "google_secret_manager_secret" "litellm_salt_key"')
  );
  assert.match(masterBlock, /prevent_destroy\s+=\s+true/);
});

test('the gateway is internal-only and the upstream URL lives on the sidecar only', () => {
  assert.match(litellmTf, /litellm_ingress/);
  const variables = read('deploy', 'gcp', 'terraform', 'variables.tf');
  assert.match(
    variables,
    /litellm_ingress[\s\S]*?default\s+=\s+"INGRESS_TRAFFIC_INTERNAL_ONLY"/,
    'a public LiteLLM would be a master-key-only endpoint anyone could spend against'
  );
  // LITELLM_PROXY_UPSTREAM is set in local.proxy_plain_env (the sidecar), and an
  // agent container must not learn the real origin.
  const cloudRun = read('deploy', 'gcp', 'terraform', 'cloud_run.tf');
  assert.match(cloudRun, /LITELLM_PROXY_UPSTREAM\s*=\s*local\.litellm_url/);
  const agentEnv = read('deploy', 'gcp', 'terraform', 'cloud_run.tf');
  assert.doesNotMatch(agentEnv, /LITELLM_PROXY_UPSTREAM\s*=\s*"https:\/\//,
    'the gateway origin must not be hardcoded onto an agent container');
});

// --- Images: third-party upstreams must arrive pinned, and CI must roll them ---

const LITELLM_DOCKERFILES = {
  app: read('deploy', 'gcp', 'Dockerfile.litellm-app'),
  db: read('deploy', 'gcp', 'Dockerfile.litellm-db'),
  redis: read('deploy', 'gcp', 'Dockerfile.litellm-redis'),
};

test('every LiteLLM base image is pinned by digest', () => {
  // Cloud Run only pulls from Artifact Registry, so these Dockerfiles ARE the
  // mirror step (see deploy/gcp/Dockerfile.litellm-redis). A floating `FROM
  // redis:7-alpine` would let an upstream rebuild change the gateway under us,
  // and LiteLLM's Admin UI + /key/* RPC shapes move between releases.
  for (const [name, source] of Object.entries(LITELLM_DOCKERFILES)) {
    const froms = [...source.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
    assert.ok(froms.length > 0, `${name}: no FROM`);
    for (const from of froms) {
      // Allowed: an ARG default (asserted pinned below) or a digest reference.
      if (/^\$\{[A-Z_]+\}$/.test(from)) continue;
      assert.match(from, /@sha256:[0-9a-f]{64}$/, `${name}: unpinned base ${from}`);
    }
    const args = [...source.matchAll(/^ARG\s+\w+=(\S+)$/gm)].map((m) => m[1]);
    for (const arg of args) {
      assert.match(arg, /@sha256:[0-9a-f]{64}$/, `${name}: unpinned base default ${arg}`);
    }
  }
});

test('the app overlay puts config.yaml where Terraform points CONFIG_FILE_PATH', () => {
  // A one-sided rename starts LiteLLM with an empty model list: it boots healthy
  // and rejects every model (403), which looks like a gateway bug rather than a
  // build bug.
  const copy = LITELLM_DOCKERFILES.app.match(/^COPY\s+deploy\/litellm\/config\.yaml\s+(\S+)$/m);
  assert.ok(copy, 'the overlay must COPY deploy/litellm/config.yaml to a single target');
  const declared = LITELLM_DOCKERFILES.app.match(/^ENV\s+CONFIG_FILE_PATH=(\S+)$/m);
  assert.equal(declared && declared[1], copy[1]);
  const variables = read('deploy', 'gcp', 'terraform', 'variables.tf');
  assert.match(
    variables,
    new RegExp(`litellm_config_path[\\s\\S]*?default\\s+=\\s+"${copy[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
    'var.litellm_config_path must match the path baked into the image'
  );
});

test('CI builds and rolls all three LiteLLM images as one unit', () => {
  const ci = read('.github', 'workflows', 'deploy.yml');
  // Paths-filter must name every input, or a config-only change deploys nothing.
  const filter = ci.match(/litellm:\s+\[([^\]]+)\]/);
  assert.ok(filter, 'deploy.yml needs a litellm paths-filter entry');
  for (const input of [
    'deploy/litellm/**',
    'deploy/gcp/Dockerfile.litellm-app',
    'deploy/gcp/Dockerfile.litellm-db',
    'deploy/gcp/Dockerfile.litellm-redis',
    'deploy/gcp/terraform/litellm.tf',
  ]) {
    assert.ok(filter[1].includes(input), `litellm filter is missing ${input}`);
  }
  const LITELLM_IMAGES = {
    litellm: 'deploy/gcp/Dockerfile.litellm-app',
    'litellm-db': 'deploy/gcp/Dockerfile.litellm-db',
    'litellm-redis': 'deploy/gcp/Dockerfile.litellm-redis',
  };
  for (const [image, dockerfile] of Object.entries(LITELLM_IMAGES)) {
    assert.ok(
      ci.includes(`push ${image} ${image} ${dockerfile} .`),
      `${image} must be built from ${dockerfile} at the repo root`
    );
  }
  // A single resolved tag feeds all three -var= lines: the sidecars share one
  // ephemeral instance and must never be assembled from three different runs.
  assert.match(ci, /write_tag litellm resolve_optional litellm ai-fleet-litellm/);
  const tagLines = [...ci.matchAll(/-var="litellm(?:_db|_redis)?_image_tag=\$\{\{ steps\.tags\.outputs\.litellm \}\}/g)];
  assert.equal(tagLines.length, 3, 'all three image tags must resolve from one output');
  assert.match(ci, /-var="litellm_enabled=\$\{\{ vars\.LITELLM_ENABLED \|\| 'false' \}\}"/);
});

test('litellm image tags follow the fleet per-service fallback', () => {
  const locals = read('deploy', 'gcp', 'terraform', 'locals.tf');
  const variables = read('deploy', 'gcp', 'terraform', 'variables.tf');
  // Empty default + var.image_tag fallback is what lets CI roll ONE service while
  // every other service's apply stays a no-op.
  for (const name of ['litellm_image_tag', 'litellm_db_image_tag', 'litellm_redis_image_tag']) {
    assert.match(variables, new RegExp(`variable "${name}"[\\s\\S]*?default\\s+=\\s+""`), `${name} must default to ""`);
  }
  for (const local of ['litellm_tag', 'litellm_db_tag', 'litellm_redis_tag']) {
    assert.match(
      locals,
      new RegExp(`${local}\\s+=\\s+var\\.[a-z_]+_image_tag != "" \\? var\\.[a-z_]+_image_tag : var\\.image_tag`),
      `${local} must fall back to var.image_tag`
    );
  }
  for (const [image, tagLocal] of [
    ['litellm', 'litellm_tag'],
    ['litellm-db', 'litellm_db_tag'],
    ['litellm-redis', 'litellm_redis_tag'],
  ]) {
    // CI pushes <AR_REPO>/<image>:<SHA> and litellm.tf consumes the local below.
    // Renaming either side makes the service point at a nonexistent artifact,
    // which Cloud Run reports as an opaque startup failure rather than a config bug.
    const reference = '/' + image + ':${local.' + tagLocal + '}';
    assert.ok(locals.includes(reference), `${image} must resolve under local.image_base with local.${tagLocal}`);
  }
  assert.match(litellmTf, /image\s+=\s+local\.litellm_image/);
  assert.match(litellmTf, /image\s+=\s+local\.litellm_db_image/);
  assert.match(litellmTf, /image\s+=\s+local\.litellm_redis_image/);
});
