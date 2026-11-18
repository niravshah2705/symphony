import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as browser from './workflow-designer-model.mjs';

const require = createRequire(import.meta.url);
const server = require('../../packages/shared-core/src/workflow/model.js');

const here = path.dirname(fileURLToPath(import.meta.url));

// The browser canvas cannot `require` a CommonJS module, so the v2 contract is
// deliberately duplicated in public/js/workflow-designer-model.mjs. This test is
// the seam: anything the two agree on must stay agreed, and anything one side
// starts enforcing that the other does not fails here rather than in production.
test('v2 model is loaded from both sides of the seam', () => {
  assert.ok(here.endsWith('public/js'));
  assert.equal(typeof browser.normalizeKagentSpec, 'function');
  assert.equal(typeof server.normalizeKagentSpec, 'function');
});

test('v2 vocabulary constants match the shared-core model', () => {
  for (const name of [
    'WORKFLOW_SCHEMA_VERSION_V2',
    'WORKFLOW_NODE_KINDS_V2',
    'WORKFLOW_NODE_BACKENDS',
    'TASK_TIERS',
    'MODEL_FAMILIES',
    'HARNESS_OPTIONS',
    'GATE_CARD_MAX',
    'GATE_ITEM_MAX',
    'PERSONAS',
    'PERSONA_LABELS',
    'DEFAULT_PERSONA_GRANTS',
  ]) {
    assert.deepEqual(browser[name], server[name], `${name} drifted between browser and server`);
  }
});

/**
 * The canvas refuses an agent node whose refId is not in its catalog, and it
 * refuses silently — so a platform profile the gateway merged into the tenant
 * but the browser never mirrored is a node that vanishes from the graph with
 * no error anywhere. The two lists must stay the same list.
 */
test('browser agent catalog mirrors every platform default agent profile', () => {
  const defaults = require('../../packages/shared-core/src/workflow-defaults.js').DEFAULT_AGENT_PROFILES;
  const browserById = new Map(browser.CURATED_AGENT_CATALOG.map((profile) => [profile.id, profile]));
  const serverById = new Map(defaults.map((profile) => [profile.id, profile]));

  for (const profile of defaults) {
    const mirrored = browserById.get(profile.id);
    assert.ok(mirrored, `${profile.id} is a platform profile the canvas would drop`);
    assert.equal(mirrored.name, profile.name, `${profile.id} name drifted`);
    assert.equal(mirrored.category, profile.category, `${profile.id} category drifted`);
    assert.equal(mirrored.description, profile.purpose, `${profile.id} purpose drifted`);
    // A category no persona allows would hide the profile from the palette.
    if (profile.persona) {
      assert.equal(browser.personaAllowsCategory(profile.persona, profile.category), true,
        `${profile.id} (${profile.category}) is not grantable to its own ${profile.persona} persona`);
    }
  }
  for (const profile of browser.CURATED_AGENT_CATALOG) {
    assert.ok(serverById.has(profile.id), `${profile.id} exists in the browser catalog but not on the server`);
  }
});

const OCI = 'ghcr.io/acme/skills/review@sha256:' + 'a'.repeat(64);
const GIT_REF = { git: { repo: 'https://github.com/acme/skills', commit: 'b'.repeat(40) } };

const KAGENT_CASES = [
  ['non-object', null],
  ['empty', {}],
  ['valid full spec', {
    modelConfig: { name: 'openrouter-model-config', namespace: 'kagent' },
    skills: [{ name: 'code-review', source: { oci: OCI }, promptAppend: 'Review for injection.' }],
    plugins: [{ source: { oci: 'ghcr.io/acme/plugin@sha256:' + 'c'.repeat(64) }, skills: ['ship'], promptAppend: 'Sign off.' }],
    tools: [
      { kind: 'mcp', server: 'kagent-tool-server', tools: ['search'], requireApproval: true, promptAppend: 'Cite sources.' },
      { kind: 'subAgent', name: 'planner', templateRef: 'agent-template-planner', description: 'Plans work' },
    ],
    env: [{ name: 'LOG_LEVEL', value: 'debug' }],
    egressPolicyRefs: ['allow-openrouter'],
  }],
  ['modelConfig without namespace', { modelConfig: { name: 'default-model-config' } }],
  ['modelConfig bad name', { modelConfig: { name: 'Not A Name' } }],
  ['git skill source (upstream-broken)', { skills: [{ name: 'git-skill', source: GIT_REF }] }],
  ['unpinned oci skill source', { skills: [{ name: 'loose', source: { oci: 'ghcr.io/acme/skills:latest' } }] }],
  ['duplicate skill names', { skills: [{ name: 'dup', source: { oci: OCI } }, { name: 'dup', source: { oci: 'x@sha256:' + 'd'.repeat(64) } }] }],
  ['skill list over the cap', { skills: Array.from({ length: 60 }, (_, i) => ({ name: `s${i}`, source: { oci: `r@sha256:${String(i).padStart(64, '0')}` } })) }],
  ['reserved plugin env names', { env: [{ name: 'PLUGIN_ROOT', value: '/tmp' }, { name: 'ok_key', value: 'v' }] }],
  ['credential-shaped env value', { env: [{ name: 'OPENAI_KEY', value: 'sk-' + 'a'.repeat(30) }] }],
  ['tool with both mcp and subAgent', { tools: [{ kind: 'mcp', server: 'x', subAgent: { name: 'y' } }] }],
  ['tool naming an unknown kind', { tools: [{ kind: 'weird' }] }],
];

test('normalizeKagentSpec accepts and rejects identically on both sides', () => {
  for (const [label, input] of KAGENT_CASES) {
    const a = browser.normalizeKagentSpec(structuredClone(input));
    const b = server.normalizeKagentSpec(structuredClone(input));
    assert.deepEqual(a, b, `normalizeKagentSpec diverged for case "${label}"`);
    assert.deepEqual(browser.kagentSpecWarnings(a), server.kagentSpecWarnings(b),
      `kagentSpecWarnings diverged for case "${label}"`);
  }
});

const NODE_CASES = [
  ['no prompt or appends', {}],
  ['node prompt only', { systemPrompt: 'You are a reviewer.' }],
  ['appends without node prompt', {
    systemPrompt: '',
    kagentSpec: { skills: [{ name: 'a', source: { oci: OCI }, promptAppend: 'Append A.' }], plugins: [{ source: { oci: 'r@sha256:' + 'e'.repeat(64) }, promptAppend: 'Append B.' }] },
  }],
  ['prompt plus ordered appends', {
    systemPrompt: 'Base.',
    kagentSpec: {
      skills: [{ name: 'a', source: { oci: OCI }, promptAppend: 'Append A.' }],
      tools: [{ kind: 'mcp', server: 'svc', promptAppend: 'Append C.' }],
    },
  }],
];

test('composeKagentSystemPrompt orders appends the same on both sides', () => {
  for (const [label, node] of NODE_CASES) {
    assert.equal(browser.composeKagentSystemPrompt(structuredClone(node)),
      server.composeKagentSystemPrompt(structuredClone(node)),
      `composeKagentSystemPrompt diverged for case "${label}"`);
  }
});

const GATE_CASES = [
  ['non-object', null],
  ['empty', {}],
  ['well-formed two cards', {
    cards: [
      { id: 'quality', title: 'Quality', items: ['unit', 'e2e', 'lint'], threshold: 90, passRate: 95 },
      { id: 'security', title: 'Security', items: ['sca'], threshold: 100, passRate: 100 },
    ],
    summaryRules: 'Any red card blocks.',
  }],
  ['more cards than allowed', { cards: Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, title: `C${i}`, items: ['x'] })) }],
  ['card with too many items', { cards: [{ id: 'c', title: 'C', items: ['a', 'b', 'c', 'd'] }] }],
  ['threshold out of range', { cards: [{ id: 'c', title: 'C', items: ['a'], threshold: 140 }] }],
];

test('gate config normalizes and validates the same on both sides', () => {
  for (const [label, input] of GATE_CASES) {
    assert.deepEqual(browser.normalizeGateConfig(structuredClone(input)), server.normalizeGateConfig(structuredClone(input)),
      `normalizeGateConfig diverged for case "${label}"`);
    assert.deepEqual(browser.validateGateConfig(structuredClone(input)), server.validateGateConfig(structuredClone(input)),
      `validateGateConfig diverged for case "${label}"`);
  }
});

test('v1 migration produces the same v2 graph on both sides', () => {
  const v1 = {
    id: 'flow-1', name: 'Intake', description: 'v1 graph',
    createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    nodes: [
      { id: 'n1', kind: 'agent', refId: 'planning', name: 'Plan', x: 10, y: 20 },
      { id: 'n2', kind: 'approval', name: '', x: 40, y: 50 },
      { id: 'n3', kind: 'agent', refId: 'build', name: 'Build', x: 70, y: 20 },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3', outcome: 'approved' },
      { id: 'e3', source: 'n3', target: 'n1', outcome: 'approved' },
    ],
  };
  const migrated = browser.migrateV1ToV2(structuredClone(v1));
  const serverMigrated = server.migrateV1ToV2(structuredClone(v1));
  assert.deepEqual(migrated, serverMigrated, 'migrateV1ToV2 diverged');
  assert.equal(migrated.nodes[0].backend, 'substrate');
  assert.equal(migrated.nodes[0].taskTier, 'medium');
  // A nameless approval node must not be relabelled differently per side: the
  // server rewriting it would fight the canvas on every save.
  assert.equal(migrated.nodes[1].name, 'Human approval');
  assert.equal(migrated.createdAt, v1.createdAt);
  // e3 closes a cycle back to n1 and must be dropped by both sides.
  assert.deepEqual(migrated.edges.map((edge) => edge.id), ['e1', 'e2']);
  assert.equal(migrated.edges[1].outcome, 'approved');
});

test('persona grants are enforced identically on both sides', () => {
  for (const persona of server.PERSONAS) {
    for (const category of ['Planning', 'Coding', 'Launch', 'Compliance', 'Custom', 'Ideation']) {
      assert.equal(browser.personaAllowsCategory(persona, category), server.personaAllowsCategory(persona, category),
        `personaAllowsCategory diverged for ${persona}/${category}`);
    }
    assert.deepEqual([...(browser.allowedCategoriesForPersona(persona) ?? [])],
      [...(server.allowedCategoriesForPersona(persona) ?? [])],
      `allowedCategoriesForPersona diverged for ${persona}`);
  }
});
