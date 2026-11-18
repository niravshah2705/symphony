'use strict';

// The "Stage mandatory secret versions" step runs with a six-variable subset of
// the deploy var set. Everything it plans beyond the secret containers is
// therefore evaluated against defaults, and three of those defaults disagree
// with live production: firestore_location (nam5 vs the deployed region),
// google_one_tap_client_id (empty → count 0) and custom_domain (empty → the
// for_each drops the live hosting domain). These tests keep the step to a
// targeted, read-only plan, keep destroy guards on the resources a cleared repo
// variable would otherwise remove, and keep the one apply it may run to
// `-refresh-only` — recording state addresses, never touching infrastructure.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

function resourceBlock(source, type, name) {
  const start = source.indexOf(`resource "${type}" "${name}"`);
  assert.notEqual(start, -1, `missing Terraform resource ${type}.${name}`);
  const next = source.indexOf('\nresource "', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function secretStageStep(workflow) {
  const start = workflow.indexOf('- name: Stage mandatory secret versions');
  assert.notEqual(start, -1, 'deploy workflow lost the secret staging step');
  const next = workflow.indexOf('\n      - name: ', start + 1);
  return workflow.slice(start, next === -1 ? workflow.length : next);
}

// Real shell invocations only: an echo of a command an operator must run by hand
// is documentation, not something this job executes.
function stagedTerraformCommands(step) {
  return step
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\bterraform (plan|apply|destroy|import)\b/.test(line) && !line.startsWith('echo'))
    .map((line) => ({
      verb: line.match(/\bterraform (plan|apply|destroy|import)\b/)[1],
      line,
    }));
}

test('secret staging step plans, and its only apply can touch nothing but state', () => {
  const step = secretStageStep(read('.github/workflows/deploy.yml'));

  for (const target of [
    'google_secret_manager_secret.flexprice["flexprice-api-key-ingest"]',
    'google_secret_manager_secret.flexprice["flexprice-api-key-money"]',
    'google_secret_manager_secret.stream_token_secret',
    'google_secret_manager_secret.identity_hash_pepper',
    'google_secret_manager_secret.cashfree_app_id',
    'google_secret_manager_secret.cashfree_secret_key',
  ]) {
    assert.ok(step.includes(target), `secret container missing from -target: ${target}`);
  }

  const commands = stagedTerraformCommands(step);
  assert.equal(commands.length, 2, `expected the targeted plan and its post-move retry, got ${commands.length}`);
  for (const { verb, line } of commands) {
    if (verb === 'plan') {
      assert.ok(
        line.includes('-target') || line.includes('secret_targets[@]'),
        `un-targeted plan would evaluate the whole stack on a partial var set: ${line}`,
      );
      continue;
    }
    assert.match(
      line,
      /-refresh-only/,
      `an apply that is not -refresh-only can create, change or delete real infrastructure: ${line}`,
    );
  }
});

test('a pending state move is recorded state-only, then the plan is retried', () => {
  const step = secretStageStep(read('.github/workflows/deploy.yml'));
  assert.match(step, /Moved resource instances excluded by targeting/);
  assert.ok(
    step.includes('grep -oE') && step.includes('-target="[^"]+"'),
    'the addresses to record come from terraform, not a list here that goes stale',
  );
  assert.match(step, /terraform apply -refresh-only -auto-approve/);
  assert.match(step, /::error::Could not record the pending state moves/, 'a failed record hands off the command');
  assert.ok(
    step.indexOf('terraform apply -refresh-only') < step.indexOf('seed_secret stream-token-secret'),
    'secrets are only seeded once the targeted plan actually ran',
  );
});

test('flexprice secret references fail loud instead of mounting a placeholder', () => {
  const billing = read('deploy/gcp/terraform/billing_service.tf');
  const start = billing.indexOf('billing_flexprice_secrets = {');
  assert.notEqual(start, -1, 'billing_flexprice_secrets local is gone');
  const block = billing.slice(start, billing.indexOf('}', start));
  assert.doesNotMatch(block, /\btry\(/, 'try() hides a missing secret as a runtime 500');
  assert.doesNotMatch(block, /"dummy"/);
  assert.match(block, /google_secret_manager_secret\.flexprice\["flexprice-api-key-ingest"\]\.secret_id/);
  assert.match(block, /google_secret_manager_secret\.flexprice\["flexprice-api-key-money"\]\.secret_id/);
});

test('resources a cleared repo variable would remove refuse the destroy', () => {
  const guards = [
    ['deploy/gcp/terraform/firestore.tf', 'google_firestore_database', 'default'],
    ['deploy/gcp/terraform/cloud_run.tf', 'google_secret_manager_secret', 'google_one_tap_client_id'],
    ['deploy/gcp/terraform/firebase.tf', 'google_firebase_hosting_custom_domain', 'default'],
  ];
  for (const [file, type, name] of guards) {
    const block = resourceBlock(read(file), type, name);
    assert.match(
      block,
      /prevent_destroy\s*=\s*true/,
      `${type}.${name} can be destroyed by a var default flipping count/for_each off`,
    );
  }
});
