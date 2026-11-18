'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const defaults = require('./workflow-defaults.js');
const model = require('./workflow/model.js');

test('every default workflow is a valid v2 graph', () => {
  for (const workflow of [defaults.DEFAULT_ADLC_WORKFLOW, defaults.DEFAULT_QUICKSTART_WORKFLOW]) {
    const result = model.validateWorkflowGraphV2(workflow);
    assert.equal(result.ok, true, `${workflow.id}: ${result.errors.join('; ')}`);
    assert.equal(result.errors.length, 0);
    const dropped = workflow.nodes.length - result.workflow.nodes.length;
    assert.equal(dropped, 0, `${workflow.id} lost nodes during normalization`);
    const droppedEdges = workflow.edges.length - result.workflow.edges.length;
    assert.equal(droppedEdges, 0, `${workflow.id} lost edges during normalization`);
  }
});

test('default agent profiles cover the ADLC palette and agree with persona grants', () => {
  const profiles = defaults.DEFAULT_AGENT_PROFILES;
  assert.ok(profiles.length >= 22);
  const ids = new Set(profiles.map((p) => p.id));
  for (const id of ['requirements', 'ideation', 'planning', 'coding', 'engineering', 'quality', 'testing', 'deployment', 'monitoring', 'observability', 'incident-triage']) {
    assert.ok(ids.has(id), `missing default profile ${id}`);
  }
  for (const profile of profiles) {
    assert.ok(model.PERSONAS.includes(profile.persona), `${profile.id} has unknown persona`);
    assert.ok(model.personaAllowsCategory(profile.persona, profile.category), `${profile.id}/${profile.category} violates its persona grant`);
    assert.ok(model.WORKFLOW_NODE_BACKENDS.includes(profile.backend));
    assert.ok(model.TASK_TIERS.includes(profile.taskTier));
    if (profile.backend === 'kagent') {
      const result = model.normalizeKagentSpec(profile.kagent);
      assert.equal(result.errors.length, 0, `${profile.id}: ${result.errors.join('; ')}`);
      assert.deepEqual(model.kagentSpecWarnings(result), []);
    }
  }
});

test('gate template matches the code.html Specs Gate shape', () => {
  const gate = defaults.DEFAULT_GATE_TEMPLATE;
  const validation = model.validateGateConfig({ id: gate.id, title: gate.title, cards: gate.cards });
  assert.equal(validation.ok, true);
  assert.equal(gate.cards.length, model.GATE_CARD_MAX);
  for (const card of gate.cards) {
    assert.equal(card.items.length, model.GATE_ITEM_MAX);
    assert.ok(card.threshold >= 0 && card.threshold <= 100);
  }
  assert.deepEqual(gate.cards.map((c) => c.title), [
    'Business Analysis', 'Cloud Selection', 'Cost Analysis',
    'Business Metrics', 'Revenue Model', 'Timeline Defined',
  ]);
});

test('defaults are frozen and cloneDefaults returns an isolated mutable copy', () => {
  const snapshot = JSON.stringify(defaults.DEFAULT_AGENT_PROFILES);
  const copy = defaults.cloneDefaults();
  assert.equal(Object.isFrozen(defaults.DEFAULT_AGENT_PROFILES), true);
  copy.agentProfiles[0].name = 'Mutated';
  assert.equal(defaults.DEFAULT_AGENT_PROFILES[0].name !== 'Mutated', true);
  assert.equal(JSON.stringify(defaults.DEFAULT_AGENT_PROFILES), snapshot);
  assert.equal(copy.workflows.length, 2);
  assert.equal(copy.tenant.defaultPersona, 'builder');
  assert.equal(copy.kagentCrTemplates.group, 'api.kagent.dev');
});

test('role grants mirror the shared persona table', () => {
  for (const grant of defaults.DEFAULT_ROLE_GRANTS) {
    assert.deepEqual(grant.allowedCategories, model.DEFAULT_PERSONA_GRANTS[grant.persona]);
  }
  assert.equal(defaults.DEFAULT_ROLE_GRANTS.length, model.PERSONAS.length);
});
