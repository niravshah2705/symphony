'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SOURCE_ROOT = path.resolve(__dirname, '..');

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function makeRepo(t, kind, { commit = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `aifleet-${kind}-test-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });

  if (kind === 'skills') {
    fs.copyFileSync(
      path.join(SOURCE_ROOT, 'scripts', 'publish-skills.sh'),
      path.join(root, 'scripts', 'publish-skills.sh'),
    );
    fs.chmodSync(path.join(root, 'scripts', 'publish-skills.sh'), 0o755);
    const skills = path.join(root, 'packages', 'shared-core', 'src', 'agent', 'skills');
    fs.mkdirSync(path.join(skills, 'example'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), '*.pem\n');
    fs.writeFileSync(path.join(skills, 'skills-manifest.json'), '{"version":"v1","skills":[]}\n');
    fs.writeFileSync(path.join(skills, 'example', 'SKILL.md'), '# Example\n');
  } else {
    fs.copyFileSync(
      path.join(SOURCE_ROOT, 'scripts', 'sync-harness-registry.sh'),
      path.join(root, 'scripts', 'sync-harness-registry.sh'),
    );
    fs.chmodSync(path.join(root, 'scripts', 'sync-harness-registry.sh'), 0o755);
    fs.writeFileSync(path.join(root, 'scripts', 'build-harness-registry.js'), '// replaced by the test node shim\n');
    const registry = path.join(root, 'packages', 'shared-core', 'src', 'agent', 'registry');
    fs.mkdirSync(registry, { recursive: true });
    fs.writeFileSync(path.join(registry, 'sources.json'), '{"version":"v9","marketplaces":{},"skills":[],"plugins":[],"hooks":[]}\n');
  }

  if (commit) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', [
      '-c', 'user.name=Publish Script Test',
      '-c', 'user.email=publish-script-test@example.invalid',
      'commit', '-qm', 'fixture',
    ], { cwd: root });
  }
  return root;
}

function makeToolShims(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aifleet-publish-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'calls.log');
  fs.mkdirSync(bin, { recursive: true });

  writeExecutable(path.join(bin, 'gcloud'), `#!/usr/bin/env bash
set -euo pipefail
printf 'gcloud %s internal=%s tf=%s\n' "$*" "\${INTERNAL_API_TOKEN:-}" "\${TF_VAR_internal_api_token:-}" >> "$TOOL_LOG"
`);
  writeExecutable(path.join(bin, 'gsutil'), `#!/usr/bin/env bash
set -euo pipefail
printf 'gsutil %s internal=%s tf=%s\n' "$*" "\${INTERNAL_API_TOKEN:-}" "\${TF_VAR_internal_api_token:-}" >> "$TOOL_LOG"
if [ "$1" = "-h" ] && [ "\${3:-}" = "cp" ] && { [ "\${FAKE_LOCK_HELD:-}" = "1" ] || [ "\${FAKE_LOCK_ERROR:-}" = "1" ]; }; then
  exit 73
fi
if [ "$1" = "stat" ]; then
  [ "\${FAKE_LOCK_ERROR:-}" != "1" ] || exit 74
  printf '    Generation: 12345\n'
fi
if [ "$1" = "-m" ] && [ "$2" = "rsync" ]; then
  printf 'rsync-source %s\n' "$5" >> "$TOOL_LOG"
  find "$5" -type f -print >> "$TOOL_LOG"
fi
if [ "$1" = "ls" ]; then
  printf 'gs://fixture/object-one\ngs://fixture/object-two\n'
fi
`);
  writeExecutable(path.join(bin, 'node'), `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "--version" ]; then
  printf '%s\n' "$FAKE_NODE_VERSION"
  exit 0
fi
case "$1" in
  */build-harness-registry.js)
    [ "$GIT_TERMINAL_PROMPT" = "0" ] || exit 90
    shift
    printf 'builder %s internal=%s tf=%s\n' "$*" "\${INTERNAL_API_TOKEN:-}" "\${TF_VAR_internal_api_token:-}" >> "$TOOL_LOG"
    out=""
    dry=false
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --out) out="$2"; shift 2 ;;
        --sources|--work) shift 2 ;;
        --dry-run) dry=true; shift ;;
        *) shift ;;
      esac
    done
    if [ "$dry" = true ]; then
      printf 'Harness registry plan (version v9)\n'
      exit 0
    fi
    mkdir -p "$out/v9/generic/mcp" "$out/v9/original"
    printf '{"version":"v9"}\n' > "$out/registry-manifest.json"
    if [ "$FAKE_MCP_LEAK" = "1" ]; then
      printf '{"name":"unsafe","headers":{"Authorization":"secret"}}\n' > "$out/v9/generic/mcp/unsafe.json"
    else
      printf '{"name":"safe","command":"npx","args":[]}\n' > "$out/v9/generic/mcp/safe.json"
    fi
    if [ "$FAKE_FILE_LEAK" = "1" ]; then
      printf 'secret\n' > "$out/v9/original/auth.json"
    fi
    ;;
  *)
    exec "$REAL_NODE" "$@"
    ;;
esac
`);

  return { bin, log };
}

function run(root, script, args, tools, extraEnv = {}) {
  return spawnSync(path.join(root, 'scripts', script), args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${tools.bin}:${process.env.PATH}`,
      REAL_NODE: process.execPath,
      TOOL_LOG: tools.log,
      FAKE_NODE_VERSION: 'v22.0.0',
      FAKE_FILE_LEAK: '',
      FAKE_MCP_LEAK: '',
      FAKE_LOCK_HELD: '',
      FAKE_LOCK_ERROR: '',
      ...extraEnv,
    },
  });
}

function output(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function calls(tools) {
  return fs.existsSync(tools.log) ? fs.readFileSync(tools.log, 'utf8') : '';
}

test('skills dry-run uses the manifest version, derives the bucket, and honors CLI precedence', (t) => {
  const root = makeRepo(t, 'skills');
  const tools = makeToolShims(t);
  const envFile = path.join(os.tmpdir(), `aifleet-skills-env-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(envFile, { force: true }));
  fs.writeFileSync(envFile, 'GCP_PROJECT_ID=from-env\nSKILLS_BUCKET=env-bucket\n');

  const overridden = run(root, 'publish-skills.sh', [
    '--env-file', envFile, '--bucket', 'cli-bucket', '--dry-run',
  ], tools);
  assert.equal(overridden.status, 0, output(overridden));
  assert.match(overridden.stdout, /Skills version: v1/);
  assert.match(overridden.stdout, /gs:\/\/cli-bucket\/v1/);
  assert.equal(calls(tools), '');

  const derived = run(root, 'publish-skills.sh', [
    '--env-file', envFile, '--project', 'cli-project', '--dry-run',
  ], tools, { SKILLS_BUCKET: '', SKILLS_BUCKET_OVERRIDE: '' });
  assert.equal(derived.status, 0, output(derived));
  // The env-file bucket still wins unless it is explicitly overridden by a CLI bucket.
  assert.match(derived.stdout, /Target bucket: gs:\/\/env-bucket/);

  const projectOnly = path.join(os.tmpdir(), `aifleet-skills-project-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(projectOnly, { force: true }));
  fs.writeFileSync(projectOnly, 'GCP_PROJECT_ID=env-project\n');
  const projectResult = run(root, 'publish-skills.sh', ['--env-file', projectOnly, '--dry-run'], tools);
  assert.equal(projectResult.status, 0, output(projectResult));
  assert.match(projectResult.stdout, /Target bucket: gs:\/\/env-project-aifleet-skills/);

  fs.mkdirSync(path.join(root, 'deploy', 'gcp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'deploy', 'gcp', '.env'), 'SKILLS_BUCKET=default-env-bucket\n');
  const defaultEnv = run(root, 'publish-skills.sh', ['--dry-run'], tools, {
    SKILLS_BUCKET: '',
    SKILLS_BUCKET_OVERRIDE: '',
  });
  assert.equal(defaultEnv.status, 0, output(defaultEnv));
  assert.match(defaultEnv.stdout, /Target bucket: gs:\/\/default-env-bucket/);
});

test('skills rejects unsafe versions before publishing', (t) => {
  const root = makeRepo(t, 'skills');
  const tools = makeToolShims(t);
  const result = run(root, 'publish-skills.sh', [
    '--bucket', 'fixture', '--version', '../escape', '--dry-run',
  ], tools);
  assert.notEqual(result.status, 0);
  assert.match(output(result), /refusing invalid skills version/);
  assert.equal(calls(tools), '');
});

test('skills rejects a version that disagrees with the committed manifest', (t) => {
  const root = makeRepo(t, 'skills', { commit: true });
  const tools = makeToolShims(t);
  const result = run(root, 'publish-skills.sh', [
    '--bucket', 'fixture', '--version', 'v2',
  ], tools);
  assert.notEqual(result.status, 0);
  assert.match(output(result), /requested skills version 'v2' does not match manifest version 'v1'/);
  assert.equal(calls(tools), '');
});

test('publishers fail fast when Node.js is older than the repo baseline', (t) => {
  const skillsRoot = makeRepo(t, 'skills');
  const registryRoot = makeRepo(t, 'registry');
  const tools = makeToolShims(t);
  const env = { FAKE_NODE_VERSION: 'v21.9.0' };

  const skills = run(skillsRoot, 'publish-skills.sh', [
    '--bucket', 'fixture', '--dry-run',
  ], tools, env);
  assert.notEqual(skills.status, 0);
  assert.match(output(skills), /Node\.js 22 or newer is required/);

  const registry = run(registryRoot, 'sync-harness-registry.sh', ['--dry-run'], tools, env);
  assert.notEqual(registry.status, 0);
  assert.match(output(registry), /Node\.js 22 or newer is required/);
});

test('skills publish requires a clean commit and mirrors only the selected version', (t) => {
  const root = makeRepo(t, 'skills', { commit: true });
  const tools = makeToolShims(t);
  const result = run(root, 'publish-skills.sh', [
    '--bucket', 'skills-bucket', '--version', 'v1',
  ], tools, { INTERNAL_API_TOKEN: 'must-not-leak', TF_VAR_internal_api_token: 'also-must-not-leak' });
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /Source commit: [0-9a-f]{40}/);
  const log = calls(tools);
  assert.match(log, /gcloud auth print-access-token/);
  assert.match(log, /gsutil -m rsync -r -d .* gs:\/\/skills-bucket\/v1/);
  assert.match(log, /gsutil cp .*skills-manifest\.json gs:\/\/skills-bucket\/v1\/skills-manifest\.json/);
  assert.match(log, /gsutil cp .*skills-manifest\.json gs:\/\/skills-bucket\/skills-manifest\.json/);
  assert.match(log, /gsutil -h x-goog-if-generation-match:0 cp .* gs:\/\/skills-bucket\/\.locks\/skills-publish\.lock/);
  assert.match(log, /gsutil -h x-goog-if-generation-match:12345 rm gs:\/\/skills-bucket\/\.locks\/skills-publish\.lock/);
  assert.doesNotMatch(log, /must-not-leak/);

  fs.appendFileSync(path.join(root, 'packages', 'shared-core', 'src', 'agent', 'skills', 'skills-manifest.json'), ' ');
  fs.writeFileSync(tools.log, '');
  const dirty = run(root, 'publish-skills.sh', ['--bucket', 'skills-bucket'], tools);
  assert.notEqual(dirty.status, 0);
  assert.match(output(dirty), /requires a clean committed worktree/);
  assert.equal(calls(tools), '');
});

test('skills publish archives tracked HEAD so an ignored secret-like file cannot be uploaded', (t) => {
  const root = makeRepo(t, 'skills', { commit: true });
  const tools = makeToolShims(t);
  const ignoredSecret = path.join(
    root, 'packages', 'shared-core', 'src', 'agent', 'skills', 'example', 'operator-secret.pem',
  );
  fs.writeFileSync(ignoredSecret, 'must never be published\n');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');

  const result = run(root, 'publish-skills.sh', ['--bucket', 'skills-bucket'], tools);
  assert.equal(result.status, 0, output(result));
  const log = calls(tools);
  assert.match(log, /rsync-source .*aifleet-skills-publish\..*\/packages\/shared-core\/src\/agent\/skills/);
  assert.doesNotMatch(log, /operator-secret\.pem/);
  assert.doesNotMatch(log, new RegExp(`rsync-source ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('registry dry-run performs both builder phases and both security guards without cloud access', (t) => {
  const root = makeRepo(t, 'registry');
  const tools = makeToolShims(t);
  fs.mkdirSync(path.join(root, 'deploy', 'gcp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'deploy', 'gcp', '.env'), 'REGISTRY_BUCKET=registry-env-bucket\n');
  const result = run(root, 'sync-harness-registry.sh', ['--dry-run'], tools);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /Target bucket: gs:\/\/registry-env-bucket/);
  assert.match(result.stdout, /Harness registry plan \(version v9\)/);
  assert.match(result.stdout, /MCP descriptors clean/);
  assert.match(result.stdout, /Secret-leak guard passed/);
  assert.match(result.stdout, /Dry run: built and scanned/);
  const log = calls(tools);
  assert.equal((log.match(/^builder /gm) || []).length, 2);
  assert.doesNotMatch(log, /gcloud|gsutil/);
});

test('registry refuses secret-like files and MCP credentials before upload', (t) => {
  const root = makeRepo(t, 'registry');
  const tools = makeToolShims(t);

  const fileLeak = run(root, 'sync-harness-registry.sh', ['--dry-run'], tools, {
    FAKE_FILE_LEAK: '1',
  });
  assert.notEqual(fileLeak.status, 0);
  assert.match(output(fileLeak), /secret-like files leaked/);
  assert.doesNotMatch(calls(tools), /gcloud|gsutil/);

  fs.writeFileSync(tools.log, '');
  const mcpLeak = run(root, 'sync-harness-registry.sh', ['--dry-run'], tools, {
    FAKE_MCP_LEAK: '1',
  });
  assert.notEqual(mcpLeak.status, 0);
  assert.match(output(mcpLeak), /MCP descriptor retained headers/);
  assert.doesNotMatch(calls(tools), /gcloud|gsutil/);
});

test('registry publish uses the bucket alias, version-scoped rsync, manifest pointer, and listing', (t) => {
  const root = makeRepo(t, 'registry', { commit: true });
  const tools = makeToolShims(t);
  const result = run(root, 'sync-harness-registry.sh', [], tools, {
    REGISTRY_BUCKET_OVERRIDE: 'registry-alias',
    INTERNAL_API_TOKEN: 'must-not-leak',
    TF_VAR_internal_api_token: 'also-must-not-leak',
  });
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /Source commit: [0-9a-f]{40}/);
  assert.match(result.stdout, /Published objects:.*2/);
  const log = calls(tools);
  assert.match(log, /gcloud auth print-access-token/);
  assert.match(log, /gsutil -m rsync -r -d .*\/registry\/v9 gs:\/\/registry-alias\/v9/);
  assert.match(log, /gsutil cp .*registry-manifest\.json gs:\/\/registry-alias\/registry-manifest\.json/);
  assert.match(log, /gsutil ls -r gs:\/\/registry-alias\/v9/);
  assert.match(log, /gsutil -h x-goog-if-generation-match:0 cp .* gs:\/\/registry-alias\/\.locks\/registry-publish\.lock/);
  assert.match(log, /gsutil -h x-goog-if-generation-match:12345 rm gs:\/\/registry-alias\/\.locks\/registry-publish\.lock/);
  assert.doesNotMatch(log, /must-not-leak/);
});

test('registry publish refuses a live sources override', (t) => {
  const root = makeRepo(t, 'registry', { commit: true });
  const tools = makeToolShims(t);
  const externalSources = path.join(root, 'external-sources.json');
  fs.writeFileSync(externalSources, '{"version":"v9","marketplaces":{},"skills":[],"plugins":[],"hooks":[]}\n');

  const result = run(root, 'sync-harness-registry.sh', [
    '--sources', externalSources,
  ], tools);
  assert.notEqual(result.status, 0);
  assert.match(output(result), /supported only with --dry-run/);
  assert.doesNotMatch(calls(tools), /gcloud|gsutil|builder/);
});

test('publishers refuse a held remote lock before changing a bucket prefix', (t) => {
  const tools = makeToolShims(t);
  const skillsRoot = makeRepo(t, 'skills', { commit: true });
  const skills = run(skillsRoot, 'publish-skills.sh', ['--bucket', 'skills-bucket'], tools, {
    FAKE_LOCK_HELD: '1',
  });
  assert.notEqual(skills.status, 0);
  assert.match(output(skills), /another skills publisher holds/);
  assert.doesNotMatch(calls(tools), /gsutil -m rsync/);

  fs.writeFileSync(tools.log, '');
  const registryRoot = makeRepo(t, 'registry', { commit: true });
  const registry = run(registryRoot, 'sync-harness-registry.sh', ['--bucket', 'registry-bucket'], tools, {
    FAKE_LOCK_HELD: '1',
  });
  assert.notEqual(registry.status, 0);
  assert.match(output(registry), /another registry publisher holds/);
  assert.doesNotMatch(calls(tools), /gsutil -m rsync/);
});

test('publisher lock errors distinguish contention from bucket failures', (t) => {
  const root = makeRepo(t, 'skills', { commit: true });
  const tools = makeToolShims(t);
  const result = run(root, 'publish-skills.sh', ['--bucket', 'skills-bucket'], tools, {
    FAKE_LOCK_ERROR: '1',
  });
  assert.notEqual(result.status, 0);
  assert.match(output(result), /unable to acquire .*verify bucket access and connectivity/);
  assert.doesNotMatch(output(result), /another skills publisher/);
});
