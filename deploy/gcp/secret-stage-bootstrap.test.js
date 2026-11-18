'use strict';

// The "Stage mandatory secret versions" step runs with a six-variable subset of
// the deploy var set. Everything it plans beyond the secret containers is
// therefore evaluated against defaults, and three of those defaults disagree
// with live production: firestore_location (nam5 vs the deployed region),
// google_one_tap_client_id (empty → count 0) and custom_domain (empty → the
// for_each drops the live hosting domain). These tests pin the step back to
// targeted applies and keep destroy guards on the resources a cleared repo
// variable would otherwise remove.

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

test('secret staging step plans only the secret containers it creates', () => {
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

  const invocations = (step.match(/^\s*terraform \S+.*$/gm) || []).map((line) => line.trim());
  assert.ok(invocations.length > 0, 'secret staging step runs no terraform');
  for (const line of invocations) {
    assert.match(line, /^terraform apply/, `secret staging must apply, not plan: ${line}`);
    const continues = line.endsWith('\\');
    assert.ok(
      continues || line.includes('-target') || line.includes('secret_targets[@]') ||
        /refresh-only/.test(line),
      `un-targeted terraform invocation would evaluate the whole stack: ${line}`,
    );
  }
});

test('pending state moves are recorded by an apply, not printed by a plan', () => {
  const step = secretStageStep(read('.github/workflows/deploy.yml'));
  assert.match(
    step,
    /terraform apply[^\n]*-refresh-only[^\n]*-auto-approve/,
    'a plan -refresh-only never clears a pending moved block',
  );
  assert.doesNotMatch(step, /terraform plan[^\n]*-refresh-only/);
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
