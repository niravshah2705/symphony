'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('./model.js');

const OCI = 'registry.example.com/skills/incident-triage@sha256:' + 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);

function agentNode(overrides = {}) {
  return { id: 'n1', kind: 'agent', refId: 'coding', name: 'Coding', x: 0, y: 0, ...overrides };
}

test('normalizeWorkflowV2 accepts a minimal v2 graph and defaults agent fields', () => {
  const result = model.validateWorkflowGraphV2({
    id: 'wf1', name: 'Demo', nodes: [agentNode()], edges: [],
  });
  assert.equal(result.ok, true);
  const node = result.workflow.nodes[0];
  assert.equal(node.backend, 'substrate');
  assert.equal(node.taskTier, 'medium');
  assert.deepEqual(node.connectors, []);
});

test('normalizeWorkflowV2 rejects unusable envelopes and keeps acyclic edges', () => {
  assert.equal(model.validateWorkflowGraphV2(null).ok, false);
  assert.equal(model.validateWorkflowGraphV2({ id: '', name: '' }).ok, false);
  const wf = model.normalizeWorkflowV2({
    id: 'wf', name: 'x',
    nodes: [agentNode({ id: 'a' }), agentNode({ id: 'b' })],
    edges: [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'a' }],
  });
  assert.equal(wf.edges.length, 1);
});

test('gate nodes need at least one assessment card capped at six with three items', () => {
  const cards = Array.from({ length: 8 }, (_, i) => ({
    id: `c${i}`, title: `Card ${i}`, items: ['1', '2', '3', '4'], threshold: 130,
  }));
  const node = model.normalizeNode({
    id: 'g1', kind: 'gate', name: 'Specs gate', x: 0, y: 0,
    gateConfig: { id: 'gate-template-v1', cards },
  });
  assert.equal(node.gateConfig.cards.length, model.GATE_CARD_MAX);
  assert.deepEqual(node.gateConfig.cards[0].items, ['1', '2', '3']);
  assert.equal(node.gateConfig.cards[0].threshold, 100);
  assert.equal(model.normalizeNode({ id: 'g2', kind: 'gate', gateConfig: { cards: [] } }), null);
  assert.equal(model.validateGateConfig({ cards: [{ title: 'Cost', items: ['budget'] }] }).ok, true);
  assert.equal(model.validateGateConfig({ cards: [] }).ok, false);
});

test('kagentSpec enforces the v1alpha3 CRD invariants', () => {
  const result = model.normalizeKagentSpec({
    modelConfig: { name: 'default-model-config' },
    skills: [
      { name: 'triage', source: { oci: OCI }, promptAppend: 'Always cite the runbook.' },
      { name: 'bad', source: { git: { url: 'https://x.example/r.git', commit: 'short' } } },
      { name: 'triage', source: { oci: OCI } },
    ],
    plugins: [{ source: { oci: OCI, path: '../etc' }, skills: ['log-search'] }],
    tools: [
      { kind: 'mcp', server: 'kagent-tool-server', tools: ['search'], requireApproval: true },
      { kind: 'subAgent', name: 'reviewer', templateRef: 'code-review', description: 'Delegate reviews' },
      { kind: 'mystery' },
    ],
    env: [
      { name: 'LOG_LEVEL', value: 'debug' },
      { name: 'PLUGIN_ROOT', value: '/tmp' },
      { name: 'OPENAI_API_KEY', value: 'sk-abcdefghijklmnopqrstuvwx' },
      { name: 'LOG_LEVEL', value: 'dup' },
    ],
  });
  assert.equal(result.spec.skills.length, 1);
  assert.equal(result.spec.plugins.length, 0);
  assert.equal(result.spec.tools.length, 2);
  assert.deepEqual(result.spec.env, [{ name: 'LOG_LEVEL', value: 'debug' }]);
  assert.ok(result.errors.some((message) => message.includes('immutable source')));
  assert.ok(result.errors.some((message) => message.includes('Duplicated') || message.includes('duplicated')));
  assert.ok(result.errors.some((message) => message.includes('kind mcp or subAgent')));
});

test('kagentSpec counts distinct OCI images against the 29-volume ceiling', () => {
  const skills = Array.from({ length: 30 }, (_, i) => ({
    name: `s${i}`, source: { oci: `reg.example.com/s/${i}@sha256:${'c'.repeat(64)}` },
  }));
  const result = model.normalizeKagentSpec({ skills });
  assert.equal(result.ociImages, 30);
  assert.ok(result.errors.some((message) => message.includes('29')));
});

test('git/bucket sources normalize but surface a readiness warning', () => {
  const result = model.normalizeKagentSpec({
    skills: [{ name: 'from-git', source: { git: { url: 'https://x.example/r.git', commit: COMMIT } } }],
  });
  assert.equal(result.spec.skills.length, 1);
  assert.equal(result.errors.length, 0);
  assert.match(model.kagentSpecWarnings(result)[0], /do not become Ready/);
});

test('composeKagentSystemPrompt appends skill, plugin and MCP prompts in order', () => {
  const composed = model.composeKagentSystemPrompt({
    systemPrompt: 'Base prompt.',
    kagentSpec: {
      skills: [{ name: 'a', source: { oci: OCI }, promptAppend: 'Skill note.' }, { name: 'b', source: { oci: OCI } }],
      plugins: [{ source: { oci: OCI }, skills: [], promptAppend: 'Plugin note.' }],
      tools: [{ kind: 'mcp', server: 's', promptAppend: 'MCP note.' }, { kind: 'subAgent', name: 'x', templateRef: 't', description: 'd' }],
    },
  });
  assert.equal(composed, 'Base prompt.\n\nSkill note.\n\nPlugin note.\n\nMCP note.');
});

test('agent nodes carry kagent fields through workflow normalization', () => {
  const wf = model.normalizeWorkflowV2({
    id: 'wf', name: 'graph',
    nodes: [agentNode({
      backend: 'kagent',
      harness: 'claude-code',
      modelFamily: 'anthropic',
      taskTier: 'complex',
      systemPrompt: 'Ship it.',
      connectors: ['github', '<script>evil</script>'],
      kagentSpec: { modelConfig: { name: 'default-model-config' }, env: [{ name: 'TZ', value: 'UTC' }] },
    })],
    edges: [],
  });
  const node = wf.nodes[0];
  assert.equal(node.backend, 'kagent');
  assert.equal(node.harness, 'claude-code');
  assert.deepEqual(node.connectors, ['github']);
  assert.deepEqual(node.kagentSpec.env, [{ name: 'TZ', value: 'UTC' }]);
});

test('migrateV1ToV2 backfills substrate defaults on v1 agent nodes', () => {
  const migrated = model.migrateV1ToV2({
    id: 'wf1', name: 'Legacy', updatedAt: 'not-a-date',
    nodes: [
      { id: 'a', kind: 'agent', refId: 'coding', name: 'Coding', x: 5, y: 10, modelPreference: 'quality' },
      { id: 'b', kind: 'approval', name: 'Gate', x: 0, y: 0, requiredRole: 'Release Manager' },
    ],
    edges: [{ id: 'e', source: 'a', target: 'b' }],
  });
  assert.equal(migrated.nodes[0].backend, 'substrate');
  assert.equal(migrated.nodes[0].taskTier, 'medium');
  assert.equal(migrated.nodes[1].kind, 'approval');
  assert.equal(migrated.edges.length, 1);
  assert.equal(migrated.createdAt, migrated.updatedAt);
});

test('persona grants gate agent categories with org-admin as the wildcard', () => {
  assert.equal(model.personaAllowsCategory('product-designer', 'Planning'), true);
  assert.equal(model.personaAllowsCategory('product-designer', 'Coding'), false);
  assert.equal(model.personaAllowsCategory('builder', 'Coding'), true);
  assert.equal(model.personaAllowsCategory('builder', 'Requirements'), false);
  assert.equal(model.personaAllowsCategory('sre', 'Observability'), true);
  assert.equal(model.personaAllowsCategory('sre', 'Pricing'), false);
  assert.equal(model.personaAllowsCategory('org-admin', 'Anything'), true);
  assert.equal(model.allowedCategoriesForPersona('org-admin'), null);
  const customGrants = { builder: ['Coding', 'Testing'] };
  assert.equal(model.personaAllowsCategory('builder', 'Security', customGrants), false);
  assert.equal(model.personaAllowsCategory('sre', 'Observability', customGrants), true, 'unknown persona falls back to defaults');
});

test('unsafe node text is dropped', () => {
  assert.equal(model.normalizeNode(agentNode({ name: '<img src=x onerror=alert(1)>' })), null);
  const ok = model.normalizeNode(agentNode({ description: 'plain words only' }));
  assert.equal(ok.description, 'plain words only');
});
