'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSkillCrSet, renderCrSet, API_VERSION, DIGEST_PLACEHOLDER } = require('../registry/agent-crset.js');
const { GUEST_DEMO } = require('./catalog.js');
const { CONFIG } = require('../../config.js');

// The three assertions below are the reason a guest demo is allowed to exist at
// all: it renders the genuine four-CR set, and it renders *only* that.
function renderGuest() {
  return buildSkillCrSet({
    skill: GUEST_DEMO.agent,
    cliKey: GUEST_DEMO.cliKey,
    workerPool: CONFIG.GUEST_DEMO.workerPool,
    snapshotLocation: CONFIG.GUEST_DEMO.snapshotLocation,
  });
}

test('the guest agent record renders the real four-CR set', () => {
  const result = renderGuest();
  assert.deepEqual(result.documents.map((doc) => doc.kind), ['ModelConfig', 'Harness', 'AgentTemplate', 'Agent']);
  assert.ok(result.documents.every((doc) => doc.apiVersion === API_VERSION));
  assert.equal(result.skillId, 'guest-webapp-demo');
  assert.equal(result.engine, 'kagent');
});

test('the Harness points at the guest pool the script creates, not the tenant default', () => {
  const harness = renderGuest().documents.find((doc) => doc.kind === 'Harness');
  assert.equal(harness.spec.substrate.workerPoolRef.name, CONFIG.GUEST_DEMO.workerPool);
  assert.equal(CONFIG.GUEST_DEMO.workerPool, 'guest-demo-pool');
  assert.equal(harness.spec.substrate.snapshotPolicy.location, CONFIG.GUEST_DEMO.snapshotLocation);
});

test('a guest Harness carries no env block at all', () => {
  const harness = renderGuest().documents.find((doc) => doc.kind === 'Harness');
  // Not "empty" — absent. An `env: []` would still be a slot a later refactor
  // could fill, and AGENTS.md forbids a provider secret reaching an agent env.
  assert.equal('env' in harness.spec, false);
  for (const doc of renderGuest().documents) {
    assert.equal('env' in (doc.spec || {}), false, `${doc.kind} grew a spec.env`);
  }
});

test('the rendered YAML holds no credential and no secret value', () => {
  const yaml = renderCrSet(renderGuest(), { header: 'simulated preview' });
  assert.match(yaml, /# ModelConfig:/);
  // The only 64-hex string is the un-published placeholder: nothing has been
  // stamped, so nothing here points at a real artifact either.
  const digests = yaml.match(/sha256:[0-9a-f]{64}/g) || [];
  assert.ok(digests.length, 'expected a digest-pinned skill source');
  assert.deepEqual([...new Set(digests)], [DIGEST_PLACEHOLDER]);
  for (const pattern of [/sk-[A-Za-z0-9_-]{8,}/, /BEGIN (RSA )?PRIVATE KEY/, /Bearer\s+\S{20,}/]) {
    assert.ok(!pattern.test(yaml), `rendered YAML matches ${pattern}`);
  }
  // A secret *name* from MODEL_DEFAULTS is expected; its value is not. The
  // emitter single-quotes scalars, so match the name with or without them.
  assert.match(yaml, /apiKeySecret: '?litellm-secrets'?/);
  assert.match(yaml, /apiKeySecretKey: '?LITELLM_MASTER_KEY'?/);
});

test('the AgentTemplate mounts the first-party demo skill from its own path', () => {
  const template = renderGuest().documents.find((doc) => doc.kind === 'AgentTemplate');
  assert.deepEqual(template.spec.skills, [{
    name: 'guest-webapp-demo',
    source: { oci: template.spec.skills[0].source.oci, path: 'skills/guest-webapp-demo' },
  }]);
  assert.match(template.spec.skills[0].source.oci, /^ghcr\.io\/local\/guest-webapp-demo-skill@sha256:/);
  assert.match(template.spec.systemPrompt, /never ask the visitor for free text/i);
});

test('the demo never needs a cluster capability to render', () => {
  // No kubectl, no substrate client, no model: the only inputs are the catalogue
  // record and the two config strings, so the gateway stays credential-free.
  assert.doesNotThrow(() => buildSkillCrSet({ skill: GUEST_DEMO.agent, cliKey: 'kagent' }));
  assert.equal(buildSkillCrSet({ skill: GUEST_DEMO.agent, cliKey: 'kagent' }).documents.length, 4);
});
