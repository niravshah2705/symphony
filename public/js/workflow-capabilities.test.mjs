import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCapabilitiesReader,
  createCatalogReader,
  harnessChoices,
  modelConfigChoices,
  mcpChoices,
  modelConfigEmptyLabel,
  modelFamilyChoices,
  familyProviders,
  modelChoices,
  capabilitiesSummary,
} from './workflow-capabilities.mjs';

function reader(responses) {
  const calls = [];
  const capabilities = createCapabilitiesReader({
    read: async () => {
      calls.push(1);
      const next = responses.shift() ?? responses[0];
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { capabilities, calls };
}

const ENABLED = Object.freeze({
  enabled: true,
  namespace: 'fleet-agents',
  harnesses: ['my-first-harness', 'codex', 'my-first-harness', '  '],
  modelConfigs: ['openrouter-model-config', 'default-model-config'],
  remoteMcpServers: ['kagent-tool-server'],
  agentTemplates: [],
});

test('the reader dedupes concurrent opens and caches only a real answer', async () => {
  const { capabilities, calls } = reader([ENABLED]);
  const [first, second] = await Promise.all([capabilities.load('org-a'), capabilities.load('org-a')]);
  assert.equal(calls.length, 1, 'two node inspectors opened at once are one cluster read');
  assert.deepEqual(first, second);
  assert.equal(first.namespace, 'fleet-agents');
  assert.deepEqual(first.harnesses, ['my-first-harness', 'codex'], 'a duplicated or blank name is not a second choice');

  await capabilities.load('org-a');
  assert.equal(calls.length, 1, 'an enabled read is cached for the next inspector');

  capabilities.forget('org-a');
  await capabilities.load('org-a');
  assert.equal(calls.length, 2, 'forget is the seam a re-read after an operator changes the cluster uses');

  await capabilities.load('org-b');
  assert.equal(calls.length, 3, 'the cache is keyed per organization, not global');
});

test('a refused or failed read is remembered, and only an explicit re-read asks again', async () => {
  const { capabilities, calls } = reader([
    { enabled: false, reason: 'kagent_not_configured' },
    new Error('gateway unavailable'),
    ENABLED,
  ]);
  const off = await capabilities.load('org-a');
  assert.equal(off.enabled, false);
  assert.equal(off.reason, 'kagent_not_configured');
  assert.deepEqual(off.modelConfigs, []);

  await capabilities.load('org-a');
  await capabilities.load('org-a');
  assert.equal(calls.length, 1, 'the inspector redraws on every edit; a refusal must not turn that into a request per redraw');
  assert.deepEqual(capabilities.peek('org-a'), off, 'a refusal is what the field shows, so the summary can name the reason');

  const failed = await capabilities.load('org-a', { force: true });
  assert.equal(failed.enabled, false, 'a thrown read degrades to no cluster names rather than rejecting the inspector');
  assert.equal(failed.reason, 'read_failed');
  assert.match(failed.error, /gateway unavailable/);

  const on = await capabilities.load('org-a', { force: true });
  assert.equal(on.enabled, true, 'force is how a designer picks up a cluster the operator just turned on');
  assert.equal(calls.length, 3);
  assert.equal(capabilities.peek('org-a').namespace, 'fleet-agents');
});

test('choices put what the namespace holds above what the platform ships', () => {
  const { capabilities } = reader([ENABLED]);
  return capabilities.load('org-a').then((caps) => {
    const harnesses = harnessChoices(caps, ['claude-code', 'codex', 'otel']);
    assert.deepEqual(harnesses.map((item) => item.value), ['my-first-harness', 'codex', 'claude-code', 'otel']);
    assert.equal(harnesses[0].source, 'cluster');
    assert.equal(harnesses[1].source, 'cluster');
    assert.equal(harnesses[2].source, 'platform', 'a platform harness is offered but marked as not yet deployed');

    assert.deepEqual(modelConfigChoices(caps).map((item) => item.value), ['openrouter-model-config', 'default-model-config']);
    assert.deepEqual(mcpChoices(caps).map((item) => item.value), ['kagent-tool-server']);
    assert.equal(modelConfigEmptyLabel(caps), 'Cluster default (from the Harness)');
    assert.match(capabilitiesSummary(caps), /fleet-agents/);
  });
});

test('an empty namespace and an unread one are described differently', () => {
  const bare = { enabled: true, namespace: '', harnesses: [], modelConfigs: [], remoteMcpServers: [], agentTemplates: [] };
  assert.equal(modelConfigEmptyLabel(null), 'Reading the cluster…');
  assert.equal(modelConfigEmptyLabel(bare), 'No ModelConfig in this namespace');
  assert.equal(modelConfigEmptyLabel({ enabled: false }), 'No ModelConfig names available (kagent not configured)');
  assert.match(capabilitiesSummary(null), /Reading the cluster/);
  assert.match(capabilitiesSummary({ enabled: false, reason: 'kagent_not_configured' }), /503/);
  assert.deepEqual(harnessChoices(null, ['codex']), [{ value: 'codex', label: 'codex', source: 'platform' }]);
});

test('global runtime images slot between cluster names and the static list', () => {
  const caps = { harnesses: ['my-first-harness'] };
  const globalImages = [{ runtime: 'claude', image: 'ghcr.io/x/claude-runtime', version: '2.1.326' }, { runtime: 'codex', image: '', version: '' }];
  const choices = harnessChoices(caps, ['claude-code', 'codex', 'openspec'], globalImages);
  assert.deepEqual(choices.map((item) => [item.value, item.source]), [
    ['my-first-harness', 'cluster'],
    ['claude', 'global'],
    ['codex', 'global'],
    ['claude-code', 'platform'],
    ['openspec', 'platform'],
  ]);
});

test('model families come from the served registry, models from the preset providers it claims', () => {
  const presets = [
    { id: 'claude-opus-4-8', provider: 'claude', model: 'claude-opus-4-8', label: 'Claude Opus' },
    { id: 'gpt-5-codex', provider: 'codex', model: 'gpt-5-codex', label: 'GPT-5 Codex' },
    { id: 'ollama-gpt-oss-20b', provider: 'ollama', model: 'gpt-oss:20b', label: 'GPT-OSS 20B' },
  ];
  const families = [
    { id: 'anthropic', label: 'Anthropic Claude', icon: 'anthropic', providers: ['claude'], order: 10, enabled: true },
    { id: 'openai', label: 'OpenAI', icon: 'openai', providers: ['codex'], order: 20, enabled: true },
    { id: 'bedrock', label: 'AWS Bedrock', icon: 'graph', providers: [], order: 30, enabled: true },
    { id: 'byok', label: 'Bring your own model', icon: 'byom', providers: ['ollama', 'lmstudio'], order: 40, enabled: true },
    { id: 'vertexai', label: 'Google Vertex AI', icon: 'chart', providers: [], order: 50, enabled: false },
  ];
  assert.deepEqual(modelFamilyChoices(families).map((item) => [item.value, item.label, item.source]), [
    ['anthropic', 'Anthropic Claude', 'global'],
    ['openai', 'OpenAI', 'global'],
    ['bedrock', 'AWS Bedrock', 'global'],
    ['byok', 'Bring your own model', 'global'],
  ], 'a disabled family leaves the new-selection list, and the label is the registry\'s');

  // A graph saved on a family that has since been hidden or deleted still shows
  // what it holds: the field must not silently rewrite the value. A hidden
  // family keeps its registry label on that node; only a family the file no
  // longer lists at all falls back to the bare saved id.
  assert.deepEqual(modelFamilyChoices(families, 'vertexai').map((item) => [item.value, item.label, item.source]), [
    ['anthropic', 'Anthropic Claude', 'global'],
    ['openai', 'OpenAI', 'global'],
    ['bedrock', 'AWS Bedrock', 'global'],
    ['byok', 'Bring your own model', 'global'],
    ['vertexai', 'Google Vertex AI', 'global'],
  ]);
  assert.deepEqual(modelFamilyChoices(families, 'mistral').map((item) => item.value).slice(-1), ['mistral']);
  assert.deepEqual(modelFamilyChoices([], 'mistral'), [{ value: 'mistral', label: 'mistral', icon: '', source: 'saved' }]);
  assert.deepEqual(modelFamilyChoices([]), [], 'an unread catalog offers no families rather than an invented list');

  assert.deepEqual(modelChoices(presets, 'anthropic', families), [{ value: 'claude-opus-4-8', label: 'Claude Opus · claude-opus-4-8', source: 'global' }]);
  assert.deepEqual(modelChoices(presets, 'byok', families).map((item) => item.value), ['ollama-gpt-oss-20b']);
  assert.deepEqual(modelChoices(presets, 'bedrock', families), [], 'a family that claims no provider has no preset models');
  assert.deepEqual(modelChoices(presets, 'anthropic', []), [], 'without the registry there is no provider mapping to filter by');
  assert.deepEqual(modelChoices(presets, '', families), []);
  assert.deepEqual(familyProviders(families, 'byok'), ['ollama', 'lmstudio']);
  assert.deepEqual(familyProviders(families, 'nope'), []);
});

test('the catalog reader reads once and retries only on demand', async () => {
  let calls = 0;
  const catalog = createCatalogReader({
    read: async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return {
        harnesses: [{ runtime: 'claude' }],
        modelFamilies: [{ id: 'anthropic', label: 'Anthropic Claude', providers: ['claude'] }],
        modelFamilyProblems: [],
        plugins: [{ id: 'ecc' }],
        skills: [],
      };
    },
  });
  const refused = await catalog.load();
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.modelFamilies, [], 'a refused read carries an empty family list, not undefined');
  assert.equal(catalog.peek().ok, false);
  await catalog.load();
  assert.equal(calls, 1, 'a refused read is remembered, not re-issued');
  const settled = await catalog.load({ force: true });
  assert.equal(settled.ok, true);
  assert.equal(settled.plugins.length, 1);
  assert.deepEqual(settled.modelFamilies.map((family) => family.id), ['anthropic'], 'the reader must not drop the family registry');
  assert.equal(calls, 2);
});
