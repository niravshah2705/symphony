'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { enforceLlmModel, applyOperationalPrefs, isPolicyDeniedError } = require('./policy-runtime');

test('enforceLlmModel substitutes only an allowed model from the same provider', () => {
  const catalog = { presets: [
    { id: 'provider-a-one', provider: 'provider-a', model: 'one' },
    { id: 'provider-a-two', provider: 'provider-a', model: 'two' },
    { id: 'provider-b-one', provider: 'provider-b', model: 'one' },
  ] };
  const descriptor = { provider: 'provider-a', model: 'one', accessToken: 'kept' };
  const effectivePolicy = { models: { effective: ['provider-a-two', 'provider-b-one'] } };

  assert.deepEqual(enforceLlmModel(descriptor, effectivePolicy, catalog), {
    provider: 'provider-a', model: 'two', accessToken: 'kept',
  });
  assert.throws(
    () => enforceLlmModel(descriptor, { models: { effective: ['provider-b-one'] } }, catalog),
    (error) => isPolicyDeniedError(error) && error.domain === 'model' && error.status === 403,
  );
  assert.equal(enforceLlmModel(descriptor, null, catalog), descriptor);
});

test('enforceLlmModel rejects unknown/custom models whenever models are governed', () => {
  const catalog = { presets: [{ id: 'provider-a-one', provider: 'provider-a', model: 'one' }] };
  const custom = { provider: 'provider-a', model: 'custom-unregistered-model' };
  assert.throws(
    () => enforceLlmModel(custom, { models: { effective: ['provider-a-one'] } }, catalog),
    (error) => isPolicyDeniedError(error) && error.resource === 'custom-unregistered-model',
  );
  assert.equal(enforceLlmModel(custom, {}, catalog), custom, 'no models domain retains local allow-all');
});

test('applyOperationalPrefs overlays runtime, workflow pattern, and tracing without mutating defaults', () => {
  const defaults = { agentRuntime: 'deepagent', workflowPattern: 'sequential', langsmithTracing: true };
  const messages = [];
  const result = applyOperationalPrefs(defaults, {
    agentRuntime: 'codex-sdk',
    workflowPattern: 'supervisor',
    langsmithTracing: 'false',
  }, (message) => messages.push(message));

  assert.deepEqual(result, {
    agentRuntime: 'codex-sdk', workflowPattern: 'supervisor', langsmithTracing: false,
  });
  assert.deepEqual(defaults, {
    agentRuntime: 'deepagent', workflowPattern: 'sequential', langsmithTracing: true,
  });
  assert.equal(messages.length, 2);
});
