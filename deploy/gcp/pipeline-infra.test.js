'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const DEPLOY_LIB = path.join(ROOT, 'deploy', 'gcp', 'deploy-lib.sh');
const { changedPaths, createPlan } = require('./deploy-plan');

function writeExecutable(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

// Frozen migration contract. Do not derive this from the current workflow: the
// workflow is now only a thin manual wrapper and intentionally has no filters.
const CANONICAL_DEPLOY_FILTERS = Object.freeze({
  shared: ['packages/shared/**', 'packages/shared-core/**'],
  gateway: ['services/gateway/**', 'deploy/gcp/Dockerfile.gateway'],
  planner: ['services/planner/**', 'deploy/gcp/Dockerfile.planner'],
  coder: ['services/coder/**', 'deploy/gcp/Dockerfile.coder'],
  orchestrator: ['services/orchestrator/**', 'deploy/gcp/Dockerfile.orchestrator'],
  tester: ['services/tester/**', 'deploy/gcp/Dockerfile.tester'],
  deployer: ['services/deployer/**', 'deploy/gcp/Dockerfile.deployer'],
  provisioner: ['services/provisioner/**', 'deploy/gcp/Dockerfile.provisioner'],
  proxy: ['services/proxy/**', 'deploy/gcp/Dockerfile.proxy'],
  spa: [
    'public/**', 'firebase.json', 'scripts/obfuscate-spa.js',
    'package.json', 'package-lock.json', '.github/workflows/deploy.yml',
  ],
  infra: ['deploy/gcp/terraform/**'],
  root: ['package.json', 'package-lock.json'],
  org: ['services/org/**'],
  settings: ['services/settings/**'],
  email: ['services/email/**', 'deploy/gcp/Dockerfile.email'],
});

function runGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function examplePath(pattern) {
  return pattern.endsWith('/**') ? `${pattern.slice(0, -3)}/path-filter-probe.txt` : pattern;
}

function planSummary(paths, options) {
  const plan = createPlan(paths, options);
  return {
    changed: plan.changed,
    services: plan.services.map(({ id }) => id),
    spa: plan.spa,
    terraform: plan.terraform,
  };
}

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
  ]);
  const expectedInventory = [...servicesByFile]
    .flatMap(([file, services]) => services.map((service) => [file, service]))
    .sort(([fileA, serviceA], [fileB, serviceB]) => `${fileA}:${serviceA}`.localeCompare(`${fileB}:${serviceB}`));
  assert.equal(expectedInventory.length, 10);

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

test('selective deploy planner preserves path filters and force-all behavior', () => {
  assert.deepEqual(
    createPlan(['services/gateway/src/index.js']).services.map(({ id }) => id),
    ['gateway', 'proxy'],
  );
  assert.deepEqual(createPlan(['public/js/app.js']), {
    changed: ['spa'], services: [], spa: true, terraform: false,
  });
  assert.deepEqual(createPlan(['docs/GCP_DEPLOY.md']), {
    changed: [], services: [], spa: false, terraform: false,
  });
  assert.deepEqual(
    createPlan(['deploy/gcp/terraform/pipeline.tf'], { pipelineEnabled: true }).services.map(({ id }) => id),
    ['orchestrator', 'tester', 'deployer', 'proxy'],
  );

  const forced = createPlan([], { forceAll: true });
  assert.equal(forced.spa, true);
  assert.equal(forced.terraform, true);
  assert.deepEqual(forced.services.map(({ id }) => id), [
    'gateway', 'planner', 'coder', 'orchestrator', 'tester', 'deployer',
    'email', 'provisioner', 'org', 'settings', 'proxy',
  ]);
});

test('local planner preserves every path filter from the migration contract', () => {
  const filters = CANONICAL_DEPLOY_FILTERS;
  assert.deepEqual(Object.keys(filters), [
    'shared', 'gateway', 'planner', 'coder', 'orchestrator', 'tester', 'deployer',
    'provisioner', 'proxy', 'spa', 'infra', 'root', 'org', 'settings', 'email',
  ]);

  const nodeServices = [
    'gateway', 'planner', 'coder', 'orchestrator', 'tester', 'deployer',
    'email', 'provisioner', 'settings', 'proxy',
  ];
  const expectedByFilter = {
    shared: { changed: ['shared'], services: nodeServices, spa: false, terraform: true },
    gateway: { changed: ['gateway'], services: ['gateway', 'proxy'], spa: false, terraform: true },
    planner: { changed: ['planner'], services: ['planner', 'proxy'], spa: false, terraform: true },
    coder: { changed: ['coder'], services: ['coder', 'proxy'], spa: false, terraform: true },
    orchestrator: { changed: ['orchestrator'], services: ['orchestrator', 'proxy'], spa: false, terraform: true },
    tester: { changed: ['tester'], services: ['tester', 'proxy'], spa: false, terraform: true },
    deployer: { changed: ['deployer'], services: ['deployer', 'proxy'], spa: false, terraform: true },
    provisioner: { changed: ['provisioner'], services: ['provisioner', 'proxy'], spa: false, terraform: true },
    proxy: { changed: ['proxy'], services: ['proxy'], spa: false, terraform: true },
    spa: { changed: ['spa'], services: [], spa: true, terraform: false },
    infra: { changed: ['infra'], services: ['proxy'], spa: false, terraform: true },
    root: { changed: ['root', 'spa'], services: nodeServices, spa: true, terraform: true },
    org: { changed: ['org'], services: ['org', 'proxy'], spa: false, terraform: true },
    settings: { changed: ['settings'], services: ['settings', 'proxy'], spa: false, terraform: true },
    email: { changed: ['email'], services: ['email', 'proxy'], spa: false, terraform: true },
  };
  const expectedByPath = {
    'package.json': expectedByFilter.root,
    'package-lock.json': expectedByFilter.root,
  };

  let exercised = 0;
  for (const [filter, patterns] of Object.entries(filters)) {
    assert.notDeepEqual(patterns, [], `historical filter ${filter} must contain a path`);
    for (const pattern of patterns) {
      const file = examplePath(pattern);
      assert.deepEqual(
        planSummary([file]),
        expectedByPath[file] || expectedByFilter[filter],
        `historical ${filter} filter ${pattern}`,
      );
      exercised += 1;
    }
  }
  assert.equal(exercised, 31);
});

test('changedPaths uses the merge base and ignores changes unique to the since ref', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-plan-merge-base-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  runGit(repo, ['init', '--quiet']);
  runGit(repo, ['config', 'user.name', 'Deploy planner test']);
  runGit(repo, ['config', 'user.email', 'deploy-planner@example.invalid']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  runGit(repo, ['add', 'base.txt']);
  runGit(repo, ['commit', '--quiet', '-m', 'base']);
  const base = runGit(repo, ['rev-parse', 'HEAD']);

  runGit(repo, ['checkout', '--quiet', '-b', 'since-side']);
  fs.mkdirSync(path.join(repo, 'services', 'planner'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'services', 'planner', 'since-only.js'), 'since side\n');
  runGit(repo, ['add', 'services/planner/since-only.js']);
  runGit(repo, ['commit', '--quiet', '-m', 'since side']);
  const since = runGit(repo, ['rev-parse', 'HEAD']);

  runGit(repo, ['checkout', '--quiet', '-b', 'target-side', base]);
  fs.mkdirSync(path.join(repo, 'services', 'gateway'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'public', 'js'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'services', 'gateway', 'target-only.js'), 'target side\n');
  fs.writeFileSync(path.join(repo, 'public', 'js', 'file with spaces.js'), 'target spa\n');
  runGit(repo, ['add', 'services/gateway/target-only.js', 'public/js/file with spaces.js']);
  runGit(repo, ['commit', '--quiet', '-m', 'target side']);
  const target = runGit(repo, ['rev-parse', 'HEAD']);

  const twoDotPaths = runGit(repo, ['diff', '--name-only', `${since}..${target}`]).split('\n');
  assert.ok(twoDotPaths.includes('services/planner/since-only.js'));

  const paths = changedPaths(repo, since, target);
  assert.deepEqual(paths, ['public/js/file with spaces.js', 'services/gateway/target-only.js']);
  assert.deepEqual(planSummary(paths), {
    changed: ['gateway', 'spa'],
    services: ['gateway', 'proxy'],
    spa: true,
    terraform: true,
  });
});

test('changedPaths rebuilds both sides of cross-boundary renames and service deletions', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-plan-renames-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  runGit(repo, ['init', '--quiet']);
  runGit(repo, ['config', 'user.name', 'Deploy planner test']);
  runGit(repo, ['config', 'user.email', 'deploy-planner@example.invalid']);
  fs.mkdirSync(path.join(repo, 'services', 'gateway'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'services', 'gateway', 'shared.js'), 'same source\n');
  fs.writeFileSync(path.join(repo, 'services', 'gateway', 'removed.js'), 'removed source\n');
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '--quiet', '-m', 'base']);
  const base = runGit(repo, ['rev-parse', 'HEAD']);

  fs.mkdirSync(path.join(repo, 'services', 'planner'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  runGit(repo, ['mv', 'services/gateway/shared.js', 'services/planner/shared.js']);
  runGit(repo, ['mv', 'services/gateway/removed.js', 'docs/removed.js']);
  runGit(repo, ['commit', '--quiet', '-m', 'cross-boundary renames']);
  const target = runGit(repo, ['rev-parse', 'HEAD']);

  const paths = changedPaths(repo, base, target).sort();
  assert.deepEqual(paths, [
    'docs/removed.js',
    'services/gateway/removed.js',
    'services/gateway/shared.js',
    'services/planner/shared.js',
  ]);
  assert.deepEqual(planSummary(paths), {
    changed: ['gateway', 'planner'],
    services: ['gateway', 'planner', 'proxy'],
    spa: false,
    terraform: true,
  });
});

test('local deploy produces the same Cloud Run image architecture on every host', () => {
  const deploy = read('deploy/gcp/deploy.sh');
  assert.match(deploy, /DOCKER_PLATFORM="\$\{DOCKER_PLATFORM:-linux\/amd64\}"/);
  assert.match(deploy, /docker build --platform "\$DOCKER_PLATFORM"/);
});

test('local deploy builds only the committed snapshot and excludes auth artifacts', () => {
  const deploy = read('deploy/gcp/deploy.sh');
  const dockerignore = read('.dockerignore');
  assert.match(deploy, /git -C "\$REPO_ROOT" archive --format=tar "\$DEPLOY_SHA"/);
  assert.match(deploy, /-f "\$SOURCE_ROOT\/\$dockerfile" -t "\$image" "\$SOURCE_ROOT\/\$context"/);
  assert.doesNotMatch(deploy, /-f "\$REPO_ROOT\/\$dockerfile"/);
  assert.match(dockerignore, /^gha-creds-\*\.json$/m);
  assert.match(dockerignore, /^\*\*\/\.env\.\*$/m);
});

test('deploy exposes the internal token only to Terraform apply', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-token-scope-'));
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-token-tools-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  t.after(() => fs.rmSync(tools, { recursive: true, force: true }));

  for (const relative of [
    'deploy/gcp/deploy.sh', 'deploy/gcp/deploy-lib.sh', 'deploy/gcp/deploy-plan.js',
  ]) {
    const destination = path.join(repo, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), destination);
    fs.chmodSync(destination, 0o755);
  }
  fs.mkdirSync(path.join(repo, 'deploy', 'gcp', 'terraform'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'public'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'deploy', 'gcp', 'terraform', 'main.tf'), 'terraform {}\n');
  fs.writeFileSync(path.join(repo, 'deploy', 'gcp', 'Dockerfile.gateway'), 'FROM scratch\n');
  fs.writeFileSync(path.join(repo, 'public', 'index.html'), '<main>fixture</main>\n');
  fs.writeFileSync(path.join(repo, 'scripts', 'obfuscate-spa.js'), '// shimmed in test\n');
  fs.writeFileSync(path.join(repo, 'firebase.json'), '{"hosting":{"public":"public"}}\n');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"deploy-fixture","private":true}\n');

  runGit(repo, ['init', '--quiet']);
  runGit(repo, ['config', 'user.name', 'Deploy token test']);
  runGit(repo, ['config', 'user.email', 'deploy-token@example.invalid']);
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '--quiet', '-m', 'fixture']);

  const bin = path.join(tools, 'bin');
  const log = path.join(tools, 'children.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(log, '');
  const envLog = `printf '%s|%s|internal=%s|tf=%s\\n' "$1" "$2" "\${INTERNAL_API_TOKEN:-}" "\${TF_VAR_internal_api_token:-}" >> "$CHILD_LOG"`;
  writeExecutable(path.join(bin, 'node'), `#!/usr/bin/env bash
set -euo pipefail
${envLog.replace('"$1" "$2"', 'node "$*"')}
if [ "\${1:-}" = "-e" ]; then exit 0; fi
case "\${1:-}" in
  */deploy-plan.js)
    printf '%s\\n' '{"changed":[],"services":[{"id":"gateway","image":"gateway","dockerfile":"deploy/gcp/Dockerfile.gateway","context":"."}],"spa":true,"terraform":true}'
    ;;
  */obfuscate-spa.js)
    out=''
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--out" ]; then out="$2"; shift 2; else shift; fi
    done
    mkdir -p "$out"
    printf '<main>staged</main>\\n' > "$out/index.html"
    ;;
  *) exit 91 ;;
esac
`);
  for (const command of ['docker', 'npm', 'npx', 'terraform']) {
    writeExecutable(path.join(bin, command), `#!/usr/bin/env bash
set -euo pipefail
printf '${command}|%s|internal=%s|tf=%s\\n' "$*" "\${INTERNAL_API_TOKEN:-}" "\${TF_VAR_internal_api_token:-}" >> "$CHILD_LOG"
`);
  }
  writeExecutable(path.join(bin, 'gsutil'), `#!/usr/bin/env bash
set -euo pipefail
printf 'gsutil|%s|internal=%s|tf=%s\\n' "$*" "\${INTERNAL_API_TOKEN:-}" "\${TF_VAR_internal_api_token:-}" >> "$CHILD_LOG"
if [ "\${1:-}" = "stat" ]; then printf '    Generation: 24680\\n'; fi
`);
  writeExecutable(path.join(bin, 'gcloud'), `#!/usr/bin/env bash
set -euo pipefail
printf 'gcloud|%s|internal=%s|tf=%s\\n' "$*" "\${INTERNAL_API_TOKEN:-}" "\${TF_VAR_internal_api_token:-}" >> "$CHILD_LOG"
if [ "\${1:-} \${2:-}" = "projects describe" ]; then printf '123456\\n'; fi
if [ "\${1:-} \${2:-}" = "run services" ]; then printf 'test.pkg/image:%s\\n' "$LIVE_SHA"; fi
`);

  const result = spawnSync(path.join(repo, 'deploy', 'gcp', 'deploy.sh'), ['--all'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CHILD_LOG: log,
      LIVE_SHA: 'b'.repeat(40),
      GCP_PROJECT_ID: `token-scope-${process.pid}`,
      TF_STATE_BUCKET: 'fixture-state',
      SPA_BUCKET: 'fixture-spa',
      INTERNAL_API_TOKEN: 'control-plane-secret',
      TF_VAR_internal_api_token: 'fallback-secret',
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const childLines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(childLines.some((line) => line.startsWith('npm|')));
  assert.ok(childLines.some((line) => line.startsWith('npx|')));
  assert.ok(childLines.some((line) => line.startsWith('docker|')));
  assert.ok(childLines.some((line) => line.includes('x-goog-if-generation-match:0 cp')));
  assert.ok(childLines.some((line) => line.includes('x-goog-if-generation-match:24680 rm')));
  assert.ok(childLines.some((line) => line.startsWith('gcloud|auth application-default print-access-token|')));
  const apply = childLines.find((line) => line.startsWith('terraform|') && line.includes(' apply '));
  assert.ok(apply, childLines.join('\n'));
  assert.match(apply, /internal=\|tf=control-plane-secret$/);
  for (const line of childLines) {
    if (line !== apply) assert.doesNotMatch(line, /control-plane-secret|fallback-secret/);
  }
});

test('local deploy threads naming overrides into Terraform', () => {
  const deploy = read('deploy/gcp/deploy.sh');
  assert.match(deploy, /-var="gateway_service_name=\$\{GATEWAY_SERVICE_NAME\}"/);
  assert.match(deploy, /-var="registry_bucket_name=\$\{REGISTRY_BUCKET\}"/);
});

test('unchanged gateway resolution honors the configured service name', () => {
  const sha = 'a'.repeat(40);
  const result = spawnSync('bash', ['-c', `
set -euo pipefail
. "$DEPLOY_LIB"
DEPLOY_SHA=${sha}
DEPLOY_SERVICES_JSON='[]'
GCP_PROJECT_ID=test-project
GCP_REGION=test-region
GATEWAY_SERVICE_NAME=custom-gateway
PIPELINE_ORCHESTRATOR_ENABLED=false
PROVISIONING_ENABLED=false
gcloud() {
  printf 'CALL:%s\\n' "$*" >&2
  printf 'test.pkg/image:${sha}\\n'
}
write_all_tags >/dev/null
`], { encoding: 'utf8', env: { ...process.env, DEPLOY_LIB } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /CALL:run services describe custom-gateway /);
  assert.doesNotMatch(result.stderr, /CALL:run services describe gateway /);
});

test('deploy image resolver rejects missing and mutable live tags', () => {
  const sha = 'a'.repeat(40);
  const failed = spawnSync('bash', ['-c', `
set -euo pipefail
. "$DEPLOY_LIB"
DEPLOY_SERVICES_JSON='[]'
DEPLOY_SHA=${sha}
GCP_PROJECT_ID=test-project
GCP_REGION=test-region
gcloud() { return 72; }
write_tag gateway resolve_tag gateway gateway
echo "resolver failure was masked" >&2
`], { encoding: 'utf8', env: { ...process.env, DEPLOY_LIB } });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Unable to resolve image tag output gateway/);
  assert.doesNotMatch(failed.stderr, /resolver failure was masked/);

  const mutable = spawnSync('bash', ['-c', `
set -euo pipefail
. "$DEPLOY_LIB"
GCP_PROJECT_ID=test-project
GCP_REGION=test-region
gcloud() { printf '%s\n' 'test.pkg/gateway:latest'; }
live_tag gateway
`], { encoding: 'utf8', env: { ...process.env, DEPLOY_LIB } });
  assert.notEqual(mutable.status, 0);
  assert.match(mutable.stderr, /Refusing non-immutable image tag/);
});

test('optional image resolver uses a SHA placeholder only while disabled', () => {
  const sha = 'a'.repeat(40);
  const prefix = `
set -euo pipefail
. "$DEPLOY_LIB"
DEPLOY_SHA=${sha}
GCP_PROJECT_ID=test-project
GCP_REGION=test-region
`;

  const disabled = spawnSync('bash', ['-c', `${prefix}
DEPLOY_SERVICES_JSON='[]'
gcloud() { echo "disabled optional service was queried" >&2; return 70; }
resolve_optional_tag orchestrator pipeline-orchestrator false
`], { encoding: 'utf8', env: { ...process.env, DEPLOY_LIB } });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(disabled.stdout.trim(), sha);

  const built = spawnSync('bash', ['-c', `${prefix}
DEPLOY_SERVICES_JSON='[{"id":"orchestrator"}]'
gcloud() { echo "rebuilt optional service was queried" >&2; return 71; }
resolve_optional_tag orchestrator pipeline-orchestrator true
`], { encoding: 'utf8', env: { ...process.env, DEPLOY_LIB } });
  assert.equal(built.status, 0, built.stderr);
  assert.equal(built.stdout.trim(), sha);

  const liveSha = 'b'.repeat(40);
  const enabled = spawnSync('bash', ['-c', `${prefix}
DEPLOY_SERVICES_JSON='[]'
gcloud() { printf '%s\\n' "test.pkg/pipeline-orchestrator:${liveSha}"; }
resolve_optional_tag orchestrator pipeline-orchestrator true
`], { encoding: 'utf8', env: { ...process.env, DEPLOY_LIB } });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(enabled.stdout.trim(), liveSha);

  const invalid = spawnSync('bash', ['-c', `${prefix}
DEPLOY_SERVICES_JSON='[]'
gcloud() { return 72; }
resolve_optional_tag orchestrator pipeline-orchestrator unexpected
`], { encoding: 'utf8', env: { ...process.env, DEPLOY_LIB } });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid enablement flag for optional service/);
});

test('required image resolution failure makes the tag output step fail', () => {
  const failed = spawnSync('bash', ['-c', `
set -euo pipefail
. "$DEPLOY_LIB"
DEPLOY_SHA=${'a'.repeat(40)}
DEPLOY_SERVICES_JSON='[]'
GCP_PROJECT_ID=test-project
GCP_REGION=test-region
gcloud() { echo "required live service lookup failed" >&2; return 72; }
write_tag gateway resolve_tag gateway gateway
echo "resolver failure was masked" >&2
`], { encoding: 'utf8', env: { ...process.env, DEPLOY_LIB } });

  assert.notEqual(failed.status, 0);
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
  assert.match(pipeline, /!var\.pipeline_orchestrator_enabled \|\| var\.egress_proxy_enabled/);
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
  }
});

test('orchestrator image remains free of the heavy shared agent SDK workspace', () => {
  const dockerfile = read('deploy/gcp/Dockerfile.orchestrator');
  assert.match(dockerfile, /COPY packages\/shared-core\//);
  assert.doesNotMatch(dockerfile, /COPY packages\/shared\//);
  assert.doesNotMatch(dockerfile, /COPY packages\/ \./);
  assert.match(dockerfile, /--workspace=@ai-fleet\/orchestrator/);
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
  assert.match(pipeline, /orchestrator\s*=\s*google_service_account\.orchestrator\[0\]\.email/);
  assert.match(resource, /name\s*=\s*"INTERNAL_API_TOKEN"/);
  assert.match(pipeline, /pipeline_proxy_invokes_settings/);
});
