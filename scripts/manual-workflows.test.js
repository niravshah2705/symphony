'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS = Object.freeze({
  'checks.yml': 'npm run checks -- --suite "$CHECKS_SUITE"',
  'cli-release.yml': 'npm run cli:release -- --version "$VERSION"',
  'deploy.yml': 'npm run gcp:deploy',
  'publish-skills.yml': 'npm run skills:publish -- --version "$VERSION"',
  'sync-harness-registry.yml': 'npm run registry:publish',
});

test('repository workflows are manual-only thin wrappers around local commands', () => {
  for (const [name, command] of Object.entries(WORKFLOWS)) {
    const source = fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
    const triggerBlock = source.slice(source.indexOf('\non:\n'), source.indexOf('\npermissions:'));
    assert.match(triggerBlock, /\n  workflow_dispatch:/, `${name} must expose workflow_dispatch`);
    assert.doesNotMatch(triggerBlock, /\n  (push|pull_request|schedule):/, `${name} must not run automatically`);
    assert.match(source, /persist-credentials:\s*false/, `${name} must not persist a repository token`);
    assert.equal((source.match(/^\s*run:/gm) || []).length, 1, `${name} must contain one run step`);
    assert.ok(source.includes(`run: ${command}`), `${name} must invoke ${command}`);
    assert.doesNotMatch(source, /^\s*run:\s*[|>]/m, `${name} must not embed shell logic`);
  }
});

test('root package exposes every canonical manual workflow command', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts.checks, 'bash scripts/run-checks.sh');
  assert.equal(scripts['cli:release'], 'bash scripts/release-cli.sh');
  assert.equal(scripts['gcp:deploy'], 'bash deploy/gcp/deploy.sh');
  assert.equal(scripts['skills:publish'], 'bash scripts/publish-skills.sh');
  assert.equal(scripts['registry:publish'], 'bash scripts/sync-harness-registry.sh');
});

test('bootstrap and deploy wrapper share Terraform state and Artifact Registry settings', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(ROOT, 'deploy', 'gcp', 'bootstrap.sh'), 'utf8');
  assert.match(workflow, /TF_STATE_PREFIX: \$\{\{ vars\.TF_STATE_PREFIX \|\| 'ai-fleet\/gcp' \}\}/);
  assert.match(workflow, /AR_REPO: \$\{\{ vars\.AR_REPO \|\| 'ai-fleet' \}\}/);
  assert.match(bootstrap, /gh variable set TF_STATE_PREFIX/);
  assert.match(bootstrap, /gh variable set AR_REPO/);
  assert.match(bootstrap, /-var="artifact_repo=\$\{AR_REPO\}"/);
});

test('bootstrap sends the internal API token to gh on stdin, never argv', () => {
  const bootstrap = fs.readFileSync(path.join(ROOT, 'deploy', 'gcp', 'bootstrap.sh'), 'utf8');
  assert.match(
    bootstrap,
    /printf '%s' "\$INTERNAL_API_TOKEN"[\s\\]*\| gh secret set INTERNAL_API_TOKEN --repo "\$REPO"/,
  );
  assert.doesNotMatch(
    bootstrap,
    /gh secret set INTERNAL_API_TOKEN[^\n]*(?:--body|\$INTERNAL_API_TOKEN)/,
  );
});
