import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILT_IN_CONTEXT_CATALOG,
  CURATED_AGENT_CATALOG,
  SEEDED_WORKFLOWS,
  WORKFLOW_SCHEMA_VERSION,
  addEdge,
  addNode,
  cloneWorkflow,
  createCustomAgent,
  createCustomContext,
  createInitialState,
  createWorkflow,
  deleteCustomAgent,
  deleteCustomContext,
  deleteNode,
  deleteWorkflow,
  graphSummary,
  moveNode,
  normalizeState,
  readStateFromStorage,
  rehydrateState,
  resetSeededWorkflows,
  serializeState,
  storageKeyForOrganization,
  updateCustomAgent,
  updateCustomContext,
  updateEdge,
  upsertWorkflow,
  wouldCreateCycle,
  writeStateToStorage,
} from './workflow-designer-model.mjs';

function deterministicDeps() {
  let id = 0;
  return {
    idFactory: (prefix) => `${prefix}-${++id}`,
    now: () => '2026-08-12T12:34:56.000Z',
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

test('catalogs cover the ADLC roles and the three neutral environment contexts', () => {
  const ids = new Set(CURATED_AGENT_CATALOG.map((profile) => profile.id));
  for (const expected of [
    'requirements', 'research', 'source-verification', 'planning', 'coding', 'testing',
    'security', 'devops-deployment', 'observability', 'incident-triage', 'support',
    'data-sanitation', 'commercial-strategy', 'pricing', 'compliance', 'launch',
    'knowledge-publishing',
  ]) assert.ok(ids.has(expected), `missing ${expected}`);

  assert.deepEqual(BUILT_IN_CONTEXT_CATALOG.map((context) => context.id), ['dev', 'beta', 'prod']);
  assert.ok(CURATED_AGENT_CATALOG.every((profile) => Object.isFrozen(profile)));
});

test('ships five valid realistic seed workflows including approvals and independent lanes', () => {
  assert.equal(SEEDED_WORKFLOWS.length, 5);
  assert.deepEqual(SEEDED_WORKFLOWS.map((workflow) => workflow.exampleId), [
    'environment-release',
    'research-to-decision',
    'commercial-launch',
    'incident-response',
    'independent-operations',
  ]);
  assert.ok(SEEDED_WORKFLOWS.slice(0, 4).every(
    (workflow) => workflow.nodes.some((node) => node.kind === 'approval'),
  ));
  assert.deepEqual(graphSummary(SEEDED_WORKFLOWS[4]), {
    componentCount: 4,
    components: [
      { nodeIds: ['io-devops'], edgeIds: [] },
      { nodeIds: ['io-support'], edgeIds: [] },
      { nodeIds: ['io-sanitize'], edgeIds: [] },
      { nodeIds: ['io-observe'], edgeIds: [] },
    ],
    standaloneNodeIds: ['io-devops', 'io-support', 'io-sanitize', 'io-observe'],
    rootNodeIds: ['io-devops', 'io-support', 'io-sanitize', 'io-observe'],
  });
});

test('uses isolated versioned storage keys and rejects unstable organization IDs', () => {
  assert.equal(storageKeyForOrganization('org-a'), 'ai-fleet.workflow-designer.v1:org-a');
  assert.notEqual(storageKeyForOrganization('org-a'), storageKeyForOrganization('org-b'));
  assert.equal(storageKeyForOrganization(''), '');
  assert.equal(storageKeyForOrganization('../other-org'), '');
});

test('initial state and catalogs are returned as mutable clones without mutating seeds', () => {
  const first = createInitialState();
  const second = createInitialState();
  first.workflows[0].name = 'Locally renamed';
  first.workflows[0].nodes[0].name = 'Changed node';
  assert.equal(second.workflows[0].name, 'Environment release');
  assert.equal(second.workflows[0].nodes[0].name, 'Change intake');
  assert.equal(SEEDED_WORKFLOWS[0].name, 'Environment release');
});

test('defensively normalizes profiles, references, duplicate IDs, links, and cycles', () => {
  const raw = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    activeWorkflowId: 'flow-a',
    customAgents: [{
      id: 'custom-safe',
      name: 'Safe agent',
      purpose: 'Prepare an internal summary.',
      inputs: ['Brief'],
      outputs: ['Summary'],
      guardrails: ['No customer data'],
      tools: ['knowledge-base'],
      skills: [],
    }],
    customContexts: [],
    workflows: [{
      id: 'flow-a',
      name: 'Recovered flow',
      nodes: [
        { id: 'a', kind: 'agent', refId: 'custom-safe', name: 'A', x: 0, y: 0 },
        { id: 'b', kind: 'agent', refId: 'testing', name: 'B', x: 100, y: 0 },
        { id: 'b', kind: 'agent', refId: 'testing', name: 'Duplicate', x: 100, y: 0 },
        { id: 'missing', kind: 'agent', refId: 'not-a-profile', name: 'Missing', x: 0, y: 0 },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'b', target: 'a' },
        { id: 'e4', source: 'a', target: 'a' },
      ],
    }],
  };
  const state = normalizeState(raw, deterministicDeps());
  assert.deepEqual(state.workflows[0].nodes.map((node) => node.id), ['a', 'b']);
  assert.deepEqual(state.workflows[0].edges, [{ id: 'e1', source: 'a', target: 'b' }]);
  assert.equal(state.customAgents[0].custom, true);

  const recovered = normalizeState({ schemaVersion: 999, workflows: [] });
  assert.equal(recovered.workflows.length, 5);
  assert.equal(recovered.activeWorkflowId, 'seed-environment-release');
});

test('serialization rehydrates clean data and recovers malformed JSON or schema versions', () => {
  const state = createInitialState();
  const roundTrip = rehydrateState(serializeState(state));
  assert.equal(roundTrip.recovered, false);
  assert.equal(roundTrip.error, null);
  assert.deepEqual(roundTrip.state, state);

  const malformed = rehydrateState('{ definitely-not-json');
  assert.equal(malformed.recovered, true);
  assert.equal(malformed.state.workflows.length, 5);
  assert.match(malformed.error, /unreadable/);

  const old = rehydrateState(JSON.stringify({ schemaVersion: 0, workflows: [] }));
  assert.equal(old.recovered, true);
  assert.equal(old.state.workflows.length, 5);

  const empty = rehydrateState(JSON.stringify({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    activeWorkflowId: null,
    workflows: [],
    customAgents: [],
    customContexts: [],
  }));
  assert.equal(empty.recovered, true);
  assert.equal(empty.state.workflows.length, 5);
});

test('storage helpers isolate organizations and report quota failures without throwing', () => {
  const storage = memoryStorage();
  const stateA = createInitialState();
  stateA.workflows[0].name = 'Organization A flow';
  assert.equal(writeStateToStorage(storage, 'org-a', stateA).ok, true);
  assert.equal(writeStateToStorage(storage, 'org-b', createInitialState()).ok, true);
  assert.equal(readStateFromStorage(storage, 'org-a').state.workflows[0].name, 'Organization A flow');
  assert.equal(readStateFromStorage(storage, 'org-b').state.workflows[0].name, 'Environment release');

  const quotaStorage = { setItem() { throw new Error('QuotaExceededError'); } };
  assert.deepEqual(writeStateToStorage(quotaStorage, 'org-a', stateA), {
    ok: false,
    key: 'ai-fleet.workflow-designer.v1:org-a',
    error: 'Workflow changes could not be saved locally.',
  });
});

test('creates and clones workflows with injected stable IDs while preserving topology', () => {
  const deps = deterministicDeps();
  const original = createWorkflow({
    name: 'Small flow',
    nodes: [
      { id: 'source', kind: 'agent', refId: 'research', name: 'Research', x: 0, y: 0 },
      { id: 'target', kind: 'agent', refId: 'testing', name: 'Test', x: 100, y: 0 },
    ],
    edges: [{ id: 'link', source: 'source', target: 'target' }],
  }, deps);
  assert.equal(original.id, 'workflow-1');
  assert.equal(original.createdAt, '2026-08-12T12:34:56.000Z');

  const copy = cloneWorkflow(original, {}, deps);
  assert.equal(copy.name, 'Small flow copy');
  assert.notEqual(copy.id, original.id);
  assert.ok(copy.nodes.every((node) => !['source', 'target'].includes(node.id)));
  assert.equal(copy.edges[0].source, copy.nodes[0].id);
  assert.equal(copy.edges[0].target, copy.nodes[1].id);

  const collisionSafe = cloneWorkflow(original, { id: original.id }, {
    idFactory: () => original.id,
    now: deps.now,
  });
  assert.notEqual(collisionSafe.id, original.id);
});

test('supports node movement/deletion and removes incident edges immutably', () => {
  const deps = deterministicDeps();
  const base = createWorkflow({ id: 'flow', name: 'Flow' }, deps);
  const first = addNode(base, { kind: 'agent', refId: 'research', name: 'Research', x: 10, y: 20 }, deps);
  const second = addNode(first.workflow, { kind: 'agent', refId: 'testing', name: 'Test', x: 30, y: 40 }, deps);
  const link = addEdge(second.workflow, { source: first.node.id, target: second.node.id }, deps);
  const moved = moveNode(link.workflow, second.node.id, { x: 95, y: -12 }, deps);
  assert.deepEqual(
    { x: moved.node.x, y: moved.node.y },
    { x: 95, y: -12 },
  );
  assert.deepEqual({ x: second.node.x, y: second.node.y }, { x: 30, y: 40 });

  const removed = deleteNode(moved.workflow, first.node.id, deps);
  assert.equal(removed.workflow.nodes.length, 1);
  assert.equal(removed.workflow.edges.length, 0);
  assert.equal(moved.workflow.edges.length, 1);
});

test('rejects self-links, duplicate links, cycles, and invalid outcome labels', () => {
  const workflow = createWorkflow({
    id: 'graph',
    name: 'Graph',
    nodes: [
      { id: 'a', kind: 'agent', refId: 'research', name: 'A' },
      { id: 'b', kind: 'agent', refId: 'testing', name: 'B' },
      { id: 'gate', kind: 'approval', name: 'Gate' },
    ],
  });
  const self = addEdge(workflow, { source: 'a', target: 'a' });
  assert.equal(self.ok, false);
  assert.match(self.error, /itself/);

  const first = addEdge(workflow, { id: 'a-b', source: 'a', target: 'b' });
  assert.equal(first.ok, true);
  assert.equal(addEdge(first.workflow, { source: 'a', target: 'b' }).ok, false);
  assert.equal(wouldCreateCycle(first.workflow, 'b', 'a'), true);
  assert.match(addEdge(first.workflow, { source: 'b', target: 'a' }).error, /cycle/);
  assert.match(addEdge(first.workflow, { source: 'b', target: 'gate', outcome: 'approved' }).error, /approval/);

  const approved = addEdge(first.workflow, { source: 'gate', target: 'a', outcome: 'rejected' });
  assert.equal(approved.ok, true);
  assert.equal(approved.edge.outcome, 'rejected');

  const relabelled = updateEdge(approved.workflow, approved.edge.id, { outcome: 'approved' });
  assert.equal(relabelled.ok, true);
  assert.equal(relabelled.edge.outcome, 'approved');
  assert.match(updateEdge(first.workflow, first.edge.id, { outcome: 'approved' }).error, /approval/);
});

test('summarizes connected components, roots, and standalone nodes', () => {
  const summary = graphSummary({
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    edges: [{ id: 'ab', source: 'a', target: 'b' }, { id: 'bc', source: 'b', target: 'c' }],
  });
  assert.equal(summary.componentCount, 2);
  assert.deepEqual(summary.components[0], { nodeIds: ['a', 'b', 'c'], edgeIds: ['ab', 'bc'] });
  assert.deepEqual(summary.standaloneNodeIds, ['d']);
  assert.deepEqual(summary.rootNodeIds, ['a', 'd']);
});

test('custom agent CRUD allows structured guidance, cascades edits, and blocks referenced deletion', () => {
  const deps = deterministicDeps();
  let state = createInitialState();
  const created = createCustomAgent(state, {
    name: 'Release evidence agent',
    category: 'Quality',
    description: 'Packages release evidence for reviewers.',
    purpose: 'Collect the evidence required for a release decision.',
    inputs: ['Test report', 'Security report'],
    outputs: ['Release evidence packet'],
    guardrails: ['Do not approve the release'],
    runtime: 'deep-agent',
    modelPreference: 'quality',
    tools: ['repository', 'test-results'],
    skills: ['release-analysis'],
  }, deps);
  assert.equal(created.ok, true);
  assert.equal(created.agent.id, 'custom-agent-1');
  assert.equal(created.agent.custom, true);
  assert.equal(created.agent.description, 'Packages release evidence for reviewers.');
  state = created.state;

  let workflow = createWorkflow({ id: 'custom-flow', name: 'Custom flow' }, deps);
  workflow = addNode(workflow, {
    id: 'custom-step',
    kind: 'agent',
    refId: created.agent.id,
    name: created.agent.name,
  }, deps).workflow;
  state = upsertWorkflow(state, workflow, deps).state;

  const updated = updateCustomAgent(state, created.agent.id, { name: 'Release evidence reviewer' }, deps);
  assert.equal(updated.ok, true);
  assert.equal(
    updated.state.workflows.find((item) => item.id === 'custom-flow').nodes[0].name,
    'Release evidence reviewer',
  );
  assert.equal(deleteCustomAgent(updated.state, created.agent.id, deps).ok, false);

  const withoutNode = deleteNode(
    updated.state.workflows.find((item) => item.id === 'custom-flow'),
    'custom-step',
    deps,
  ).workflow;
  state = upsertWorkflow(updated.state, withoutNode, deps).state;
  assert.equal(deleteCustomAgent(state, created.agent.id, deps).ok, true);
});

test('custom profiles reject secrets, HTML, executable code, unknown config, and tool arguments', () => {
  const state = createInitialState();
  const base = { name: 'Unsafe', purpose: 'Prepare a summary.' };
  assert.match(createCustomAgent(state, {
    ...base,
    purpose: 'Use api_key=sk-0123456789abcdefABCDEFGH',
  }).error, /secrets/);
  assert.match(createCustomAgent(state, { ...base, purpose: '<script>alert(1)</script>' }).error, /HTML/);
  assert.match(createCustomAgent(state, { ...base, purpose: '```js\nalert(1)\n```' }).error, /code/);
  assert.match(createCustomAgent(state, { ...base, toolArguments: { shell: true } }).error, /guided fields/);
  assert.match(createCustomAgent(state, { ...base, tools: ['repository --token value'] }).error, /identifiers/);
});

test('custom context CRUD cascades display metadata and blocks referenced deletion', () => {
  const deps = deterministicDeps();
  let state = createInitialState();
  const created = createCustomContext(state, {
    name: 'Canary',
    description: 'Limited organization validation context.',
  }, deps);
  assert.equal(created.ok, true);
  state = created.state;

  let workflow = createWorkflow({ id: 'canary-flow', name: 'Canary flow' }, deps);
  workflow = addNode(workflow, {
    id: 'canary-step',
    kind: 'environment',
    refId: created.context.id,
    name: created.context.name,
  }, deps).workflow;
  state = upsertWorkflow(state, workflow, deps).state;

  const updated = updateCustomContext(state, created.context.id, { name: 'Pre-production canary' }, deps);
  assert.equal(updated.ok, true);
  assert.equal(
    updated.state.workflows.find((item) => item.id === 'canary-flow').nodes[0].name,
    'Pre-production canary',
  );
  assert.equal(deleteCustomContext(updated.state, created.context.id, deps).ok, false);
});

test('workflow CRUD preserves custom workflows when resetting only seeded examples', () => {
  const deps = deterministicDeps();
  let state = createInitialState();
  const custom = createWorkflow({ id: 'my-flow', name: 'My workflow' }, deps);
  state = upsertWorkflow(state, custom, deps).state;
  state.workflows[0].name = 'Changed seed';
  const reset = resetSeededWorkflows(state, deps);
  assert.equal(reset.ok, true);
  state = reset.state;
  assert.equal(state.workflows[0].name, 'Environment release');
  assert.ok(state.workflows.some((workflow) => workflow.id === 'my-flow'));

  const deleted = deleteWorkflow(state, 'my-flow', deps);
  assert.equal(deleted.ok, true);
  assert.ok(!deleted.state.workflows.some((workflow) => workflow.id === 'my-flow'));

  const oneWorkflow = normalizeState({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    activeWorkflowId: 'my-flow',
    workflows: [custom],
    customAgents: [],
    customContexts: [],
  }, deps);
  assert.match(deleteWorkflow(oneWorkflow, 'my-flow', deps).error, /at least one/);
});

test('rejects workflow and profile mutations before durable collection limits are exceeded', () => {
  const deps = deterministicDeps();
  const customWorkflows = Array.from({ length: 96 }, (_, index) => createWorkflow({
    id: `custom-flow-${index}`,
    name: `Custom workflow ${index}`,
  }, deps));
  const workflowState = normalizeState({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    activeWorkflowId: customWorkflows[0].id,
    workflows: customWorkflows,
    customAgents: [],
    customContexts: [],
  }, deps);
  const reset = resetSeededWorkflows(workflowState, deps);
  assert.equal(reset.ok, false);
  assert.match(reset.error, /at most 95 custom workflows/);
  assert.equal(reset.state.workflows.length, 96);

  const state = createInitialState();
  state.customAgents = Array.from({ length: 200 }, (_, index) => ({
    id: `custom-agent-${index}`,
    name: `Custom agent ${index}`,
    category: 'Operations',
    description: 'A bounded organization agent.',
    purpose: 'Prepare a bounded internal result.',
    inputs: [],
    outputs: [],
    guardrails: [],
    runtime: 'organization-default',
    modelPreference: 'organization-default',
    tools: [],
    skills: [],
    custom: true,
  }));
  state.customContexts = Array.from({ length: 200 }, (_, index) => ({
    id: `custom-context-${index}`,
    name: `Custom context ${index}`,
    description: 'A non-secret execution context.',
    custom: true,
  }));
  assert.match(createCustomAgent(state, {
    name: 'One too many',
    purpose: 'Prepare an internal result.',
  }, deps).error, /limit/);
  assert.match(createCustomContext(state, {
    name: 'One too many',
    description: 'A non-secret execution context.',
  }, deps).error, /limit/);
});
