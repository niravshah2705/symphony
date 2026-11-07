'use strict';

// Structural invariants for deploy/gcp/terraform/observability.tf. The failure
// mode this file guards against is not a broken apply — an apply that succeeds and
// alerts on NOTHING, because a log filter names a field no running service emits,
// a threshold was copied instead of mirrored, or the deployment logs plain text
// so jsonPayload never exists. Terraform cannot see any of that; these tests can.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const tf = read('deploy', 'gcp', 'terraform', 'observability.tf');
const varsTf = read('deploy', 'gcp', 'terraform', 'variables.tf');
const apisTf = read('deploy', 'gcp', 'terraform', 'apis.tf');
const localsTf = read('deploy', 'gcp', 'terraform', 'locals.tf');

const proxySrc = read('services', 'proxy', 'src', 'proxy.js');
const notifySrc = read('packages', 'shared-core', 'src', 'billing', 'notify.js');
const usageSrc = read('packages', 'shared-core', 'src', 'billing', 'usage.js');
const loggerSrc = read('packages', 'shared-core', 'src', 'logger.js');
const pricing = require('@ai-fleet/shared-core/billing/pricing');
const gen = require('../../scripts/gen-observability-inputs.js');

/** The `jsonPayload.meta.<field>="<value>"` equalities a metric filter asserts. */
function metaEqualities(source) {
  // HCL escapes the inner quotes (`\"cred_unavailable\"`); unescape first so one
  // regex covers both the filters and any plain-string comparison.
  return [...source.replace(/\\"/g, '"').matchAll(/jsonPayload\.meta\.(\w+)="([^"]*)"/g)]
    .map(([, field, value]) => ({ field, value }));
}

/** Keys of the sidecar's decision table — the only values `decision` can hold. */
function decisionKeys() {
  const table = /const DECISION_SEVERITY = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(proxySrc);
  assert.ok(table, 'services/proxy/src/proxy.js must declare DECISION_SEVERITY');
  return Object.fromEntries(
    [...table[1].matchAll(/(\w+)\s*:\s*'(\w+)'/g)].map(([, key, severity]) => [key, severity]),
  );
}

test('every alertable egress decision is a decision the sidecar can record', () => {
  const decisions = decisionKeys();
  const named = metaEqualities(tf).filter((entry) => entry.field === 'decision');
  assert.ok(named.length >= 2, 'observability.tf must alert on more than one egress decision');
  for (const { value } of named) {
    assert.ok(decisions[value], `metric filter names decision '${value}', which proxy.js never records`);
  }
  // The two security-relevant outcomes: a refused credential is the fail-closed
  // signal of the egress boundary, and an unmatched prefix is relay probing.
  for (const required of ['cred_unavailable', 'no_route']) {
    assert.ok(
      named.some((entry) => entry.value === required),
      `decision '${required}' has no metric — the sidecar is unmonitored for it`,
    );
  }
});

test('the sidecar severity table only names levels the logger exposes', () => {
  // proxy.js calls `log[DECISION_SEVERITY[decision]](...)`. An unmapped or
  // misspelled severity is a TypeError on the request path, not a lost log line.
  const levels = new Set(['info', 'warn', 'error']);
  for (const [decision, severity] of Object.entries(decisionKeys())) {
    assert.ok(levels.has(severity), `${decision} maps to severity '${severity}', which log.* does not have`);
  }
});

test('balance thresholds are mirrored from the ledger, never copied into HCL', () => {
  const thresholds = gen.readThresholds(fs.readFileSync(gen.LEDGER_PATH, 'utf8'));
  const generated = fs.readFileSync(gen.OUT_PATH, 'utf8');
  assert.equal(generated, gen.serialize(thresholds), `${gen.OUT_PATH} is stale`);
  assert.deepEqual(JSON.parse(generated)[gen.VARIABLE], thresholds);
  // The generated file must be TRACKED. This root gitignores `*.tfvars*` because
  // that is where an operator puts real secrets — so a .auto.tfvars.json would
  // either break that rule or never reach CI, and Terraform on a fresh clone
  // would silently build no balance alerts at all.
  assert.doesNotMatch(gen.OUT_PATH, /\.tfvars\.json$/, 'a committed generated input cannot live in the *.tfvars* space');
  assert.match(
    tf,
    /jsondecode\(\s*file\("\$\{path\.module\}\/alert_thresholds\.json"\)\s*\)/,
    'observability.tf must read the generated file rather than restate it',
  );
  assert.match(tf, /for t in local\.billing_alert_thresholds_paise/, 'balance metrics must iterate the mirrored list');
  // One source only: no variable carrying a fallback copy of the numbers.
  assert.doesNotMatch(varsTf, /variable "billing_alert_thresholds_paise"/, 'variables.tf holds a second copy');
  // The point of the generated file: no threshold number appears in the HCL.
  assert.doesNotMatch(tf, /\[\s*10000\s*,\s*0\s*\]/, 'observability.tf restates the threshold list');
  assert.doesNotMatch(tf, /threshold_value\s*=\s*1[023456789]\d{3}/, 'observability.tf hardcodes a paise amount');
});

test('each metric filter names a field the emitting code actually writes', () => {
  // Cloud Logging only builds jsonPayload from a parseable JSON line, and
  // logger.js nests the structured payload under `meta`.
  assert.match(loggerSrc, /line\.meta\s*=/, 'logger.js no longer emits a meta object');
  assert.match(
    localsTf,
    /LOG_FORMAT\s*=\s*"json"/,
    'deployments must emit JSON lines: on text logs every filter below is permanently, silently zero',
  );

  assert.match(notifySrc, /event:\s*'balance_threshold_crossed'/, 'notify.js must emit the crossing event');
  assert.match(notifySrc, /thresholdPaise:\s*String\(/, 'the threshold must be emitted as a string for filter equality');
  const balance = metaEqualities(tf).filter((entry) => entry.field === 'thresholdPaise');
  assert.ok(balance.length, 'no balance alert references thresholdPaise');

  const cost = metaEqualities(tf).filter((entry) => entry.field === 'priceMatch');
  assert.equal(cost.length, 1, 'expected exactly one priceMatch metric filter');
  assert.match(usageSrc, /log\.warn\(`cost estimate priced an unmodeled provider/, 'the fallback-rate warning moved');
  // The filter counts ONLY guessed prices: a modeled provider must not resolve to
  // the value being alerted on, or the metric counts every run in the fleet.
  assert.equal(pricing.priceMatchOf('not-a-provider', 0), cost[0].value);
  assert.notEqual(pricing.priceMatchOf('claude', 0), cost[0].value);
  assert.notEqual(pricing.priceMatchOf('ollama', 0), cost[0].value);
});

test('observability is dark by default, and every resource is gated', () => {
  const decl = /variable "observability_enabled" \{([\s\S]*?)\n\}/.exec(varsTf);
  assert.ok(decl && /default\s*=\s*false/.test(decl[1]), 'observability_enabled must default to false');

  for (const block of tf.split(/\n(?=resource )/).slice(1)) {
    const [header] = block.split('\n');
    assert.match(
      block,
      /count\s*=\s*local\.observability_enabled \? 1 : 0|for_each\s*=\s*local\.observability_(sinks|metrics|alerts)/,
      `${header} creates resources regardless of the flag`,
    );
  }
  // The APIs are a project-wide side effect that outlives a destroy of this root.
  assert.match(apisTf, /observability_apis\s*=\s*var\.observability_enabled \?/, 'APIs must stay off with the module');
  // A policy with no channel is a chart that promises a notification.
  assert.match(
    tf,
    /local\.observability_enabled && length\(var\.observability_notification_channels\) > 0/,
    'alert policies must also require a notification channel',
  );
  // With no channels the counters still exist, but nothing can fire.
  assert.match(tf, /observability_alerts = \(local\.observability_enabled && length\(var\.observability_notification_channels\) > 0\)/);
});

test('sinks name services and jobs this root actually declares', () => {
  const refs = [...tf.matchAll(/var\.([a-z_]+(?:_service_name|_job_name))/g)].map(([, name]) => name);
  assert.ok(refs.length >= 6, 'the default sink list should cover the money-path services');
  for (const name of new Set(refs)) {
    assert.match(varsTf, new RegExp(`variable "${name}" \\{`), `var.${name} referenced by a sink is not declared`);
  }
  // A Cloud Run Job logs under cloud_run_job, not cloud_run_revision: one filter
  // cannot name both, and a revision-only filter misses the hourly money run.
  assert.match(tf, /resource\.type=\\"cloud_run_revision\\"/, 'no revision sink filter');
  assert.match(tf, /resource\.type=\\"cloud_run_job\\"/, 'no job sink filter — the auto-recharge run would be lost');
});
