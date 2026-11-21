'use strict';

// Structural invariants for the guest guided demo's deployment surface.
//
// The failure mode this pins is the silent one every other config in this repo
// shares: a consumer falls back to an inert default when its variable is absent,
// so Terraform setting `GUEST_WORKER_POOLL` or omitting `RATE_LIMIT_GUEST_MAX`
// produces a green plan and a guest flow that simply keeps the built-in numbers.
// The reconciliation runs in BOTH directions for that reason — an unread name is
// as invisible as an unsurfaced one, and only the second is an operator's bug.
//
// The half that costs more is the credential boundary. services/guest-deployer
// exists because the browser-facing gateway must not be able to write the guest
// hosting site, so the tests below assert that the hosting role is granted on
// the DEDICATED project only, that the broker's secret reaches exactly two
// workloads as a mounted secret, and that neither of them is the platform-wide
// INTERNAL_API_TOKEN.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TF = path.join(__dirname, 'terraform');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const tfFile = (name) => fs.readFileSync(path.join(TF, name), 'utf8');

const cloudRunTf = tfFile('cloud_run.tf');
const guestTf = tfFile('guest_deployer_service.tf');
const variablesTf = tfFile('variables.tf');
const secretsTf = tfFile('secrets.tf');
const configJs = read('packages', 'shared-core', 'src', 'config.js');
const deployConfigJs = read('services', 'guest-deployer', 'src', 'deploy-config.js');
const workflow = read('.github', 'workflows', 'deploy.yml');

const GUEST_NAME = String.raw`GUEST_[A-Z0-9_]+|RATE_LIMIT_[A-Z0-9_]+`;

// Comments carry this repo's rationale, and the rationale often names the thing
// the code refuses to do ("never INTERNAL_API_TOKEN"). Negative assertions run
// against the code, not the prose.
const stripComments = (source) => source.replace(/^\s*#.*$/gm, '');
const cloudRunCode = stripComments(cloudRunTf);
const guestCode = stripComments(guestTf);

/** The env NAMES assigned inside local.gateway_env, comments stripped first. */
function gatewayEnvNames() {
  const body = stripComments(gatewayEnvText());
  return new Set([...body.matchAll(new RegExp(`(^|[\\s{])(${GUEST_NAME})\\s*=`, 'g'))].map(([, , name]) => name));
}

/**
 * The text of `local.gateway_env = merge( … )`, bounded by parenthesis depth —
 * scanning "until the next dedent" swallows the resources below it and turns
 * every assertion here into a check on the whole file.
 */
function gatewayEnvText() {
  const marker = '  gateway_env = merge(';
  const start = cloudRunTf.indexOf(marker);
  assert.notEqual(start, -1, 'local.gateway_env moved out of cloud_run.tf');
  let depth = 0;
  for (let i = start + marker.length - 1; i < cloudRunTf.length; i += 1) {
    const ch = cloudRunTf[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return cloudRunTf.slice(start, i + 1);
    }
  }
  assert.fail('local.gateway_env is not a balanced merge() call');
  return '';
}

/** Every guest/rate-limit env name shipped code actually reads. */
function namesReadByCode() {
  const files = [
    'packages/shared-core/src/config.js',
    'services/gateway/src/guest-deployer-client.js',
    'services/gateway/src/guest-demo-runner.js',
    'services/gateway/src/rate-limit.js',
    'services/gateway/src/routes/guest-demo.js',
    'services/gateway/src/config/gateway-config.js',
    'services/guest-deployer/src/deploy-config.js',
    'services/guest-deployer/src/server.js',
    'services/guest-deployer/src/hosting.js',
    'services/guest-deployer/src/releases.js',
    'services/guest-deployer/src/service.js',
  ];
  // Three read shapes are in use: process.env.X, the boolEnv(process.env, 'X')
  // helper, and deploy-config.js's injected `env` object.
  const forms = [
    new RegExp(`process\\.env\\.(${GUEST_NAME})`, 'g'),
    new RegExp(`process\\.env,\\s*'(${GUEST_NAME})'`, 'g'),
    new RegExp(`\\benv\\.(${GUEST_NAME})`, 'g'),
  ];
  const names = new Set();
  for (const file of files) {
    if (!fs.existsSync(path.join(ROOT, ...file.split('/')))) continue;
    const source = read(...file.split('/'));
    for (const form of forms) {
      for (const [, name] of source.matchAll(form)) names.add(name);
    }
  }
  return names;
}

/** Names Terraform assigns to a container, in either the map or the block form. */
function namesEmittedBy(...files) {
  const names = new Set();
  for (const source of files.map(tfFile)) {
    const stripped = source.replace(/^\s*#.*$/gm, '');
    for (const [, name] of stripped.matchAll(new RegExp(`name\\s*=\\s*"(${GUEST_NAME})"`, 'g'))) names.add(name);
    for (const [, , name] of stripped.matchAll(new RegExp(`(^|[\\s{])(${GUEST_NAME})\\s*=`, 'g'))) names.add(name);
  }
  return names;
}

function resourceBlock(source, type, name) {
  const marker = `resource "${type}" "${name}" {`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `resource ${type}.${name} is missing`);
  const next = source.indexOf('\nresource "', start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

// GUEST_DEPLOY_DATA_DIR is the one accepted gap on the broker side: it derives
// from SOFTWARE_FACTORY_DATA_DIR, which common_env already pins, and spelling a
// second path in Terraform is how a ledger and its mount start disagreeing.
const DERIVED_DEFAULTS = new Set(['GUEST_DEPLOY_DATA_DIR']);

test('every guest setting the code can honor is reachable from Terraform', () => {
  const emitted = namesEmittedBy('cloud_run.tf', 'guest_deployer_service.tf');
  const unsurfaced = [...namesReadByCode()].filter((name) => !emitted.has(name) && !DERIVED_DEFAULTS.has(name));
  assert.deepEqual(unsurfaced, [],
    `a name config.js or deploy-config.js reads but no service receives can only be smuggled in as raw tfvars: ${unsurfaced.join(', ')}`);
});

test('Terraform sets no guest name that shipped code ignores', () => {
  const read$ = namesReadByCode();
  for (const name of namesEmittedBy('cloud_run.tf', 'guest_deployer_service.tf')) {
    assert.ok(read$.has(name), `${name} is set by Terraform but no running code reads it`);
  }
  assert.ok(read$.size >= 16, `expected the guest surface to be at least 16 names, saw ${read$.size}`);
});

test('the gateway env carries the whole guest demo surface, not just its URL', () => {
  const names = gatewayEnvNames();
  // A partial list here is the mistake that matters: GUEST_WORKER_POOL is the
  // name the rendered Harness points at, and RATE_LIMIT_GUEST_MAX is the only
  // thing standing between an anonymous visitor and unlimited session minting.
  for (const name of [
    'GUEST_DEMO_ENABLED', 'GUEST_WORKER_POOL', 'GUEST_SNAPSHOT_LOCATION',
    'GUEST_MAX_MESSAGES', 'GUEST_MAX_SESSIONS',
    'GUEST_SESSION_TTL_MS', 'GUEST_PREVIEW_TTL_MS',
    'RATE_LIMIT_GUEST_WINDOW_MS', 'RATE_LIMIT_GUEST_MAX',
    'RATE_LIMIT_KNOWLEDGE_WINDOW_MS', 'RATE_LIMIT_KNOWLEDGE_MAX',
  ]) {
    assert.ok(names.has(name), `local.gateway_env dropped ${name}`);
  }
});

test('the broker secret is a mounted secret and never plaintext in an env map', () => {
  const gatewayEnv = resourceBlock(cloudRunTf, 'google_cloud_run_v2_service', 'gateway');
  const gatewaySecret = /dynamic "env" \{\s*for_each = var\.guest_deployer_enabled \? \[1\] : \[\][\s\S]*?\n      \}\n/.exec(gatewayEnv);
  assert.ok(gatewaySecret, 'the gateway no longer delivers GUEST_DEPLOYER_INTERNAL_TOKEN conditionally');
  assert.match(gatewaySecret[0], /name = "GUEST_DEPLOYER_INTERNAL_TOKEN"/);
  // Precedent: GOOGLE_ONE_TAP_CLIENT_ID. A plaintext value would appear in the
  // revision spec, in `gcloud run services describe`, and in a state diff.
  assert.match(gatewaySecret[0], /value_source \{\s*secret_key_ref \{/,
    'GUEST_DEPLOYER_INTERNAL_TOKEN must resolve from Secret Manager at instance start');
  assert.match(gatewaySecret[0], /google_secret_manager_secret\.guest_deployer_internal_token\[0\]\.secret_id/);
  assert.doesNotMatch(gatewaySecret[0], /latest_version|secret_version/,
    'reading the version at plan time puts the credential in the rendered template');

  const broker = resourceBlock(guestCode, 'google_cloud_run_v2_service', 'guest_deployer');
  assert.match(broker, /name = "GUEST_DEPLOY_INTERNAL_TOKEN"\s*\n\s*value_source \{/,
    'the broker compares under its own name; the gateway presents it under the other');
  // The two names must not be interchangeable anywhere: swapping either one is a
  // silent auth failure on every deploy, not a plan error.
  assert.doesNotMatch(cloudRunCode, /^\s*GUEST_DEPLOY_INTERNAL_TOKEN\s*=/m);
  assert.doesNotMatch(guestCode, /GUEST_DEPLOYER_INTERNAL_TOKEN/);
  assert.doesNotMatch(guestCode, /INTERNAL_API_TOKEN/,
    'the platform S2S token must not ride into the process that can write the guest site');
  assert.doesNotMatch(guestCode, /STRIPE_|GOOGLE_OAUTH|LITELLM_MASTER|LANGFUSE_SECRET/);
});

test('the hosting grant is scoped to the dedicated guest project alone', () => {
  const grant = resourceBlock(guestCode, 'google_project_iam_member', 'guest_deployer_hosting');
  assert.match(grant, /project = var\.guest_firebase_project/,
    'hostingAdmin on the app project would let the broker republish the SPA, www and secrets sites');
  assert.match(grant, /role\s*=\s*"roles\/firebase\.hostingAdmin"/);
  assert.match(grant, /member\s*=\s*"serviceAccount:\$\{google_service_account\.guest_deployer\[0\]\.email\}"/);
  assert.doesNotMatch(grant, /roles\/firebase\.admin/, 'the broker needs no Identity Platform or project-level Firebase control');

  // Everything the broker identity is ever granted, across every root file.
  const brokerGrants = [];
  for (const file of fs.readdirSync(TF).filter((f) => f.endsWith('.tf'))) {
    const source = tfFile(file).replace(/^\s*#.*$/gm, '');
    for (const block of source.split(/\n(?=(?:resource|data|locals) ")/)) {
      if (/member\s*=\s*"serviceAccount:\$\{google_service_account\.guest_deployer/.test(block)) {
        for (const [, role] of block.matchAll(/role\s*=\s*"([^"]+)"/g)) brokerGrants.push(`${file}:${role}`);
      }
    }
  }
  assert.deepEqual(brokerGrants.sort(), [
    'guest_deployer_service.tf:roles/firebase.hostingAdmin',
    'guest_deployer_service.tf:roles/secretmanager.secretAccessor',
  ], 'the broker identity holds a publishing role and its own secret, and nothing else');

  // No second copy of the privilege: the app project never sees this SA.
  assert.doesNotMatch(guestCode, /google_project_iam_member[^}]*guest_deployer[^}]*project\s*=\s*var\.project_id/s);
});

test('the guest demo buys the gateway no substrate, cluster or internet capability', () => {
  const gatewayEnv = stripComments(gatewayEnvText());
  assert.doesNotMatch(gatewayEnv, /substrate_env|SUBSTRATE_|KAGENT_[A-Z]|GOOGLE_OAUTH|GCP_SA_|WORKLOAD_IDENTITY/,
    'the guest surface leaked a control-plane capability into the public gateway env');
  // local.gateway_env is the plaintext half of the gateway config: everything it
  // gains for the guest demo is a name, a cap, or a URL. The one credential the
  // guest feature needs is delivered through value_source, so a credential-shaped
  // key appearing here means it was added to the wrong half of the deployment.
  // FIREBASE_API_KEY is the one documented exception: it is public web config,
  // validated by the shared config guard, not a secret (locals.tf says so).
  const plaintextCredentialKeys = (gatewayEnv.match(/^\s*([A-Z0-9_]+)\s*=/gm) || [])
    .map((line) => line.trim().replace(/\s*=.*$/, ''))
    .filter((key) => /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/.test(key) && key !== 'FIREBASE_API_KEY');
  assert.deepEqual(plaintextCredentialKeys, [],
    `a credential reached the plaintext gateway env map: ${plaintextCredentialKeys.join(', ')}`);
  const guestKeys = gatewayEnv.match(/(^|[\s{])(GUEST_[A-Z0-9_]+|RATE_LIMIT_[A-Z0-9_]+)\s*=/g) || [];
  assert.ok(guestKeys.length >= 12, `the guest env scan found only ${guestKeys.length} keys — it is not pinning anything`);
  const broker = resourceBlock(guestCode, 'google_cloud_run_v2_service', 'guest_deployer');
  assert.match(broker, /ingress\s*=\s*var\.internal_ingress/, 'the broker is reachable from the internet');
  assert.doesNotMatch(guestCode, /member\s*=\s*"allUsers"/, 'an anonymous invoker could mint guest previews at will');
  // Cloud Run v2 has no allow-unauthenticated argument, but an allUsers binding
  // anywhere in the root would defeat the point of a private broker. The
  // principals are exactly two identities: the broker (hosting role + its own
  // secret) and the gateway (the same secret + invoke on the broker).
  const members = [...guestCode.matchAll(/member\s*=\s*"serviceAccount:\$\{([^}]+)\}"/g)].map(([, who]) => who);
  assert.deepEqual(members.sort(), [
    'google_service_account.gateway.email',
    'google_service_account.gateway.email',
    'google_service_account.guest_deployer[0].email',
    'google_service_account.guest_deployer[0].email',
  ], 'an unexpected principal was granted something in the broker root');
  assert.match(resourceBlock(guestCode, 'google_cloud_run_v2_service_iam_member', 'gateway_invokes_guest_deployer'),
    /member\s*=\s*"serviceAccount:\$\{google_service_account\.gateway\.email\}"/);
  // No egress relay and no tenant route inside the broker either: it is not a
  // proxy and the gateway is the only caller.
  assert.doesNotMatch(broker, /PROXY_CAPABILITIES|egress-proxy|SUBSTRATE_/);
});

test('one retention number covers the transcript and the site it links to', () => {
  const defaults = {};
  for (const name of ['guest_preview_ttl_ms', 'guest_session_ttl_ms']) {
    const m = new RegExp(`variable "${name}" \\{[\\s\\S]*?default\\s*=\\s*(\\d+)`).exec(variablesTf);
    assert.ok(m, `variable "${name}" lost its default`);
    defaults[name] = m[1];
  }
  assert.equal(defaults.guest_preview_ttl_ms, defaults.guest_session_ttl_ms,
    'two TTLs means the visitor is told one expiry and gets another');
  for (const name of ['sessionTtlMs', 'previewTtlMs']) {
    assert.match(configJs, new RegExp(`${name}: Number\\(process\\.env\\.[A-Z_]+ \\|\\| ${defaults.guest_preview_ttl_ms}\\)`),
      `config.js GUEST_DEMO.${name} no longer agrees with the Terraform default`);
  }
  // The broker derives from the same constant rather than restating a number.
  assert.match(deployConfigJs, /CONFIG\.GUEST_DEMO\.previewTtlMs/);
  // ...and terraform refuses a plan that splits them.
  assert.match(guestCode, /var\.guest_preview_ttl_ms == var\.guest_session_ttl_ms/);
});

test('the broker is a real image built by CI, not a path only compose knows', () => {
  const dockerfile = read('deploy', 'gcp', 'Dockerfile.guest-deployer');
  assert.match(dockerfile, /^COPY packages\/shared-core\/ \.\/packages\/shared-core\/$/m,
    'the templates and bundles the broker renders live in shared-core');
  assert.match(dockerfile, /^COPY services\/guest-deployer\/ \.\/services\/guest-deployer\/$/m);
  assert.match(dockerfile, /--workspace=@software-factory\/guest-deployer/);
  assert.match(dockerfile, /--include-workspace-root=false/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^CMD \["node", "services\/guest-deployer\/src\/server\.js"\]$/m);
  assert.doesNotMatch(dockerfile, /^COPY (packages|services)\/ \.\//m,
    'a whole-tree COPY would ship the gateway and the agent SDKs into the broker');

  assert.match(workflow, /guest:\s+\['services\/guest-deployer\/\*\*', 'deploy\/gcp\/Dockerfile\.guest-deployer'\]/,
    'a broker change would never trigger its own build');
  assert.match(workflow, /push guest guest-deployer deploy\/gcp\/Dockerfile\.guest-deployer/);
  assert.match(workflow, /write_tag guest resolve_optional guest guest-deployer/);
  // The tag has to reach the apply, or CI builds an image the service never rolls onto.
  assert.match(workflow, /apply_args\+=\(-var="guest_image_tag=\$\{\{ steps\.tags\.outputs\.guest \}\}"\)/);
  assert.match(workflow, /-var="guest_worker_pool=\$\{\{ vars\.GUEST_WORKER_POOL \|\| 'guest-demo-pool' \}\}"/);
  assert.match(workflow, /-var="rate_limit_guest_max=\$\{\{ vars\.RATE_LIMIT_GUEST_MAX \|\| '30' \}\}"/);
  assert.match(read('deploy', 'gcp', 'deploy.sh'), /build_push guest-deployer Dockerfile\.guest-deployer/);
});

test('enabling the broker without a guest project is refused, not guessed', () => {
  assert.match(guestCode, /condition\s*=\s*trimspace\(var\.guest_firebase_project\) != ""/);
  // The API enablement follows the same gate, so there is no state in which a
  // service exists that cannot reach Firebase Hosting.
  assert.match(tfFile('apis.tf'), /var\.guest_deployer_enabled && trimspace\(var\.guest_firebase_project\) != ""/);
  assert.match(tfFile('apis.tf'), /project\s*=\s*var\.guest_firebase_project/);
  for (const [file, type, name] of [
    ['guest_deployer_service.tf', 'google_service_account', 'guest_deployer'],
    ['guest_deployer_service.tf', 'google_firebase_project', 'guest'],
    ['guest_deployer_service.tf', 'google_firebase_hosting_site', 'guest_previews'],
    ['guest_deployer_service.tf', 'google_project_iam_member', 'guest_deployer_hosting'],
    ['guest_deployer_service.tf', 'google_secret_manager_secret_iam_member', 'guest_deployer_token_accessor'],
    ['guest_deployer_service.tf', 'google_secret_manager_secret_iam_member', 'gateway_guest_deployer_token'],
    ['guest_deployer_service.tf', 'google_cloud_run_v2_service', 'guest_deployer'],
    ['guest_deployer_service.tf', 'google_cloud_run_v2_service_iam_member', 'gateway_invokes_guest_deployer'],
    ['secrets.tf', 'google_secret_manager_secret', 'guest_deployer_internal_token'],
  ]) {
    assert.match(resourceBlock(tfFile(file), type, name),
      /count\s*=\s*(?:local|var)\.guest_deployer_enabled \? 1 : 0/,
      `${type}.${name} would be created even with the feature switched off`);
  }
  // The gateway learns the URL only under the same flag, so a disabled broker
  // leaves the runner on its skip path instead of pointing at nothing.
  assert.match(cloudRunTf, /var\.guest_deployer_enabled \? \{\s*\n\s*GUEST_DEPLOYER_URL\s*=/);
  assert.match(variablesTf,
    /variable "guest_deployer_enabled" \{\s*type\s*=\s*bool[\s\S]*?default\s*=\s*false/,
    'the broker ships dark: it needs a project and a seeded secret first');
});
