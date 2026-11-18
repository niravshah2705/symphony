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
  // ...and the reference must not be a state read either: indexing the container
  // collection is what made this step's targeted plan unrunnable until the
  // containers existed, which is the very apply this step precedes.
  assert.doesNotMatch(block, /google_secret_manager_secret\.flexprice/,
    'the secret names are constants; indexing the collection deadlocks a targeted plan');
  assert.match(block, /"flexprice-api-key-ingest"/);
  assert.match(block, /"flexprice-api-key-money"/);
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

// The two FlexPrice planes are mounted into the billing container by constant
// name, so a plane with no enabled version is not a warning: Cloud Run refuses
// the whole revision, mid-apply, after other resources have already changed.
// Seeding them with the other converged secrets moves that failure into a step
// that can name the fix — and "converged" must not slip into "generated", since
// a minted-random third-party key is permanently invalid.
test('both FlexPrice planes converge from repository secrets, never from random', () => {
  const step = secretStageStep(read('.github/workflows/deploy.yml'));
  const envBlock = step.slice(0, step.indexOf('run: |'));
  for (const [id, secret] of [
    ['flexprice-api-key-ingest', 'FLEXPRICE_API_KEY_INGEST'],
    ['flexprice-api-key-money', 'FLEXPRICE_API_KEY_MONEY'],
  ]) {
    assert.match(
      envBlock,
      new RegExp(`${secret}: \\$\\{\\{ secrets\\.${secret} \\}\\}`),
      `${secret} is not passed into the staging step, so nothing can seed ${id}`,
    );
    const line = step.split('\n').map((l) => l.trim()).find((l) => l.startsWith(`seed_secret ${id} `));
    assert.ok(line, `seed_secret ${id} is gone: the container is created by the apply that binds it`);
    assert.match(line, new RegExp(`\\$\\{${secret}:-\\}`), `${id} is not converged from ${secret}`);
    assert.doesNotMatch(line, /allow-random/, `${id} is a third-party credential; a generated key never authenticates`);
  }
});

test('a FlexPrice plane with no enabled version stops before the apply', () => {
  const wf = read('.github/workflows/deploy.yml');
  const start = wf.indexOf('- name: Verify FlexPrice secret versions');
  assert.notEqual(start, -1, 'the pre-apply FlexPrice check is gone');
  const next = wf.indexOf('\n      - name: ', start + 1);
  const step = wf.slice(start, next === -1 ? wf.length : next);
  for (const id of ['flexprice-api-key-ingest', 'flexprice-api-key-money']) {
    assert.ok(step.includes(id), `${id} is not checked`);
  }
  assert.match(
    step,
    /if \[ -z "\$v" \]; then[\s\S]{0,700}?exit 1\n\s*fi/,
    'a missing version has to fail the step, not print a note and continue',
  );
  assert.match(step, /gh secret set|repository secret/, 'the error has to name the path CI can seed from');
  const verifyAt = wf.indexOf('- name: Verify FlexPrice secret versions');
  const applyAt = wf.indexOf('- name: Terraform apply');
  assert.ok(verifyAt < applyAt, 'the check runs after the apply, which is the failure it exists to prevent');
});
