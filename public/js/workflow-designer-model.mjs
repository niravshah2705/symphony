import { scanSecrets } from './secret-scan.mjs';

// This module deliberately has no DOM dependencies. The workflow view owns all
// pointer, SVG and localStorage scheduling concerns; this file owns the durable
// contract and graph invariants.

export const WORKFLOW_SCHEMA_VERSION = 1;
export const WORKFLOW_STORAGE_PREFIX = `ai-fleet.workflow-designer.v${WORKFLOW_SCHEMA_VERSION}:`;
export const WORKFLOW_NODE_KINDS = Object.freeze(['agent', 'approval', 'environment']);
export const APPROVAL_EDGE_OUTCOMES = Object.freeze(['approved', 'rejected']);
export const AGENT_RUNTIME_OPTIONS = Object.freeze([
  'organization-default',
  'deep-agent',
  'codex-sdk',
  'claude-agent-sdk',
  'manual',
]);
export const AGENT_MODEL_PREFERENCES = Object.freeze([
  'organization-default',
  'quality',
  'balanced',
  'fast',
  'economy',
]);

const MAX_COORDINATE = 100_000;
const MAX_WORKFLOWS = 100;
const MAX_NODES = 500;
const MAX_EDGES = 2_000;
const MAX_CUSTOM_PROFILES = 200;
const SEED_TIMESTAMP = '2026-08-12T00:00:00.000Z';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_TOOL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const HTML_OR_CODE = /<\/?[A-Za-z][^>]*>|```|javascript\s*:|^#!|\$\{[^}]+\}/im;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function plainText(value, max = 500) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, max);
}

function stableId(value) {
  const id = plainText(value, 160);
  return SAFE_ID.test(id) ? id : '';
}

function finiteNumber(value, fallback = 0, min = -MAX_COORDINATE, max = MAX_COORDINATE) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normalizeTimestamp(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function timestamp(deps = {}) {
  const raw = typeof deps.now === 'function' ? deps.now() : new Date();
  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function defaultIdFactory(prefix) {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nextId(prefix, usedIds = new Set(), deps = {}) {
  const factory = typeof deps.idFactory === 'function' ? deps.idFactory : defaultIdFactory;
  const proposed = stableId(factory(prefix));
  if (proposed && !usedIds.has(proposed)) return proposed;
  const base = proposed || prefix;
  let suffix = 2;
  while (usedIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function normalizeTextList(value, { maxItems = 20, maxLength = 240, identifiers = false } = {}) {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(/\r?\n|,/) : [];
  const result = [];
  for (const item of source) {
    const text = plainText(item, maxLength);
    if (!text || (identifiers && !SAFE_TOOL_ID.test(text)) || result.includes(text)) continue;
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function unsafeText(value) {
  if (typeof value !== 'string') return false;
  return HTML_OR_CODE.test(value) || scanSecrets(value).found;
}

function unsafeList(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n|,/) : [];
  return values.some(unsafeText);
}

function validateAllowedKeys(input, allowed) {
  if (!isRecord(input)) return false;
  return Object.keys(input).every((key) => allowed.has(key));
}

function agent(
  id,
  name,
  category,
  purpose,
  inputs,
  outputs,
  guardrails,
  tools = [],
  skills = [],
) {
  return {
    id,
    name,
    category,
    description: purpose,
    purpose,
    inputs,
    outputs,
    guardrails,
    runtime: 'organization-default',
    modelPreference: 'organization-default',
    tools,
    skills,
    custom: false,
  };
}

export const CURATED_AGENT_CATALOG = deepFreeze([
  agent('requirements', 'Requirements Agent', 'Requirements', 'Turns a change request into scoped, testable acceptance criteria.', ['Change request', 'Product constraints'], ['Requirements brief', 'Acceptance criteria'], ['Flag ambiguity', 'Do not invent customer commitments'], ['linear'], ['requirements-analysis']),
  agent('research', 'Research Agent', 'Research', 'Investigates a question across approved internal and public sources.', ['Research question', 'Source policy'], ['Evidence set', 'Open questions'], ['Separate evidence from inference', 'Respect source access rules'], ['web-search'], ['deep-research']),
  agent('source-verification', 'Source Verification Agent', 'Source verification', 'Checks provenance, freshness, and claim support before synthesis.', ['Evidence set'], ['Verified source ledger', 'Rejected claims'], ['Require traceable sources', 'Surface conflicting evidence'], ['web-search'], ['source-evaluation']),
  agent('planning', 'Planning Agent', 'Planning', 'Converts approved requirements into sequenced implementation work.', ['Requirements brief', 'Architecture context'], ['Execution plan', 'Dependency map'], ['Keep tasks bounded', 'Identify approval gates'], ['project-context'], ['delivery-planning']),
  agent('coding', 'Coding Agent', 'Coding', 'Implements an approved change in an isolated development workspace.', ['Execution plan', 'Repository context'], ['Code change', 'Implementation notes'], ['Stay within approved scope', 'Never handle raw credentials'], ['repository'], ['software-development']),
  agent('testing', 'Testing Agent', 'Testing', 'Exercises functional, integration, regression, and accessibility expectations.', ['Change set', 'Acceptance criteria'], ['Test evidence', 'Defect report'], ['Do not hide flaky results', 'Preserve reproducible evidence'], ['test-runner'], ['quality-assurance']),
  agent('security', 'Security Review Agent', 'Security', 'Reviews changes for abuse paths, tenant isolation, and secret exposure.', ['Change set', 'Threat context'], ['Security findings', 'Release recommendation'], ['Never reproduce secret values', 'Escalate material risk'], ['security-scanner'], ['security-review']),
  agent('devops-deployment', 'DevOps Deployment Agent', 'DevOps / deployment', 'Prepares and performs an approved deployment using organization runbooks.', ['Release artifact', 'Deployment context'], ['Deployment record', 'Rollback status'], ['Require explicit production approval', 'Follow rollback thresholds'], ['deployment-runner'], ['deployment-operations']),
  agent('observability', 'Observability Agent', 'Observability', 'Watches service health, business signals, and release regressions.', ['Telemetry scope', 'Service objectives'], ['Health summary', 'Alert or anomaly'], ['Avoid customer-data disclosure', 'Include signal confidence'], ['metrics', 'logs', 'traces'], ['observability-analysis']),
  agent('incident-triage', 'Incident Triage Agent', 'Incident triage', 'Correlates incident signals and coordinates the first response.', ['Alerts', 'Recent change context'], ['Severity assessment', 'Response plan'], ['Do not make destructive changes', 'Escalate uncertain severity'], ['incident-console'], ['incident-response']),
  agent('support', 'Support Agent', 'Support', 'Classifies customer reports and prepares evidence-grounded responses.', ['Support case', 'Known-issue catalog'], ['Triage result', 'Response draft'], ['Protect customer data', 'Do not promise unapproved timelines'], ['support-desk'], ['support-triage']),
  agent('data-sanitation', 'Data Sanitation Agent', 'Data sanitation', 'Removes invalid, duplicated, sensitive, or policy-excluded records.', ['Candidate dataset', 'Data policy'], ['Sanitized dataset', 'Exclusion report'], ['Never persist raw secrets', 'Keep reversible audit metadata'], ['data-validator'], ['data-quality']),
  agent('commercial-strategy', 'Commercial Strategy Agent', 'Commercial strategy', 'Assesses positioning, segments, and go-to-market tradeoffs.', ['Market evidence', 'Product capabilities'], ['Commercial recommendation', 'Assumptions'], ['Label uncertain projections', 'Avoid unsupported competitor claims'], ['market-data'], ['commercial-analysis']),
  agent('pricing', 'Pricing Agent', 'Pricing', 'Models pricing options against customer value and unit economics.', ['Segment analysis', 'Cost assumptions'], ['Pricing scenarios', 'Sensitivity notes'], ['Mark assumptions', 'Require finance review for commitments'], ['pricing-model'], ['pricing-analysis']),
  agent('compliance', 'Compliance Agent', 'Compliance', 'Checks a proposed change or launch against applicable policies.', ['Proposal', 'Policy scope'], ['Compliance checklist', 'Exceptions'], ['Escalate unresolved obligations', 'Do not provide final legal approval'], ['policy-library'], ['compliance-review']),
  agent('launch', 'Launch Agent', 'Launch', 'Coordinates approved release communication and rollout tasks.', ['Approved launch plan', 'Audience'], ['Launch checklist', 'Communication package'], ['Use approved claims only', 'Honor rollout gates'], ['release-calendar'], ['launch-coordination']),
  agent('knowledge-publishing', 'Knowledge Publishing Agent', 'Knowledge publishing', 'Turns verified findings into durable organization knowledge.', ['Approved synthesis', 'Publishing policy'], ['Knowledge article', 'Source index'], ['Preserve attribution', 'Do not publish restricted material'], ['knowledge-base'], ['knowledge-management']),
]);

export const BUILT_IN_CONTEXT_CATALOG = deepFreeze([
  {
    id: 'dev',
    name: 'Dev',
    description: 'A development context for rapid, reversible experimentation.',
    custom: false,
  },
  {
    id: 'beta',
    name: 'Beta',
    description: 'A limited validation context for integration and stakeholder checks.',
    custom: false,
  },
  {
    id: 'prod',
    name: 'Prod',
    description: 'A production context governed by explicit release approval.',
    custom: false,
  },
]);

function seedNode(id, kind, refId, name, x, y, extra = {}) {
  return { id, kind, refId: refId || null, name, description: '', x, y, ...extra };
}

function seedEdge(id, source, target, outcome) {
  return { id, source, target, ...(outcome ? { outcome } : {}) };
}

function seedWorkflow(id, name, description, nodes, edges) {
  return {
    id: `seed-${id}`,
    exampleId: id,
    isExample: true,
    name,
    description,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
    viewport: { x: 40, y: 40, zoom: 0.82 },
    nodes,
    edges,
  };
}

export const SEEDED_WORKFLOWS = deepFreeze([
  seedWorkflow(
    'environment-release',
    'Environment release',
    'A gated ADLC path from change intake through Dev and Beta to production observability.',
    [
      seedNode('er-intake', 'agent', 'requirements', 'Change intake', 40, 190),
      seedNode('er-dev', 'environment', 'dev', 'Dev context', 300, 190),
      seedNode('er-build', 'agent', 'coding', 'Build', 560, 190),
      seedNode('er-beta', 'environment', 'beta', 'Beta context', 820, 190),
      seedNode('er-test', 'agent', 'testing', 'Test', 1080, 80),
      seedNode('er-security', 'agent', 'security', 'Security review', 1080, 300),
      seedNode('er-approval', 'approval', null, 'Release manager approval', 1340, 190, {
        requiredRole: 'Release Manager',
        reviewCriteria: ['Tests pass', 'Security findings resolved', 'Rollback plan ready'],
        instructions: 'Approve only when the release evidence is complete.',
        rejectionHandling: 'Return the release to Build with actionable findings.',
      }),
      seedNode('er-prod', 'environment', 'prod', 'Prod context', 1600, 190),
      seedNode('er-deploy', 'agent', 'devops-deployment', 'Production deployment', 1860, 190),
      seedNode('er-observe', 'agent', 'observability', 'Release observability', 2120, 190),
    ],
    [
      seedEdge('er-e1', 'er-intake', 'er-dev'),
      seedEdge('er-e2', 'er-dev', 'er-build'),
      seedEdge('er-e3', 'er-build', 'er-beta'),
      seedEdge('er-e4', 'er-beta', 'er-test'),
      seedEdge('er-e5', 'er-beta', 'er-security'),
      seedEdge('er-e6', 'er-test', 'er-approval'),
      seedEdge('er-e7', 'er-security', 'er-approval'),
      seedEdge('er-e8', 'er-approval', 'er-prod', 'approved'),
      seedEdge('er-e9', 'er-prod', 'er-deploy'),
      seedEdge('er-e10', 'er-deploy', 'er-observe'),
    ],
  ),
  seedWorkflow(
    'research-to-decision',
    'Research to decision',
    'Evidence is verified and sanitized before a research lead approves publication.',
    [
      seedNode('rd-research', 'agent', 'research', 'Research', 80, 180),
      seedNode('rd-verify', 'agent', 'source-verification', 'Source verification', 360, 180),
      seedNode('rd-sanitize', 'agent', 'data-sanitation', 'Data sanitation', 640, 180),
      seedNode('rd-synthesis', 'agent', 'commercial-strategy', 'Synthesis', 920, 180),
      seedNode('rd-approval', 'approval', null, 'Research lead approval', 1200, 180, {
        requiredRole: 'Research Lead',
        reviewCriteria: ['Claims trace to sources', 'Limitations are explicit'],
        instructions: 'Review evidence quality and decision relevance.',
        rejectionHandling: 'Return unsupported claims for additional research.',
      }),
      seedNode('rd-publish', 'agent', 'knowledge-publishing', 'Knowledge publishing', 1480, 180),
    ],
    [
      seedEdge('rd-e1', 'rd-research', 'rd-verify'),
      seedEdge('rd-e2', 'rd-verify', 'rd-sanitize'),
      seedEdge('rd-e3', 'rd-sanitize', 'rd-synthesis'),
      seedEdge('rd-e4', 'rd-synthesis', 'rd-approval'),
      seedEdge('rd-e5', 'rd-approval', 'rd-publish', 'approved'),
    ],
  ),
  seedWorkflow(
    'commercial-launch',
    'Commercial launch',
    'Parallel market and pricing work joins at compliance before a governed launch.',
    [
      seedNode('cl-market', 'agent', 'commercial-strategy', 'Market research', 80, 70),
      seedNode('cl-pricing', 'agent', 'pricing', 'Pricing', 80, 290),
      seedNode('cl-compliance', 'agent', 'compliance', 'Compliance', 380, 180),
      seedNode('cl-approval', 'approval', null, 'Commercial lead approval', 680, 180, {
        requiredRole: 'Commercial Lead',
        reviewCriteria: ['Positioning is evidence-based', 'Pricing and compliance are aligned'],
        instructions: 'Approve the commercial package and launch boundaries.',
        rejectionHandling: 'Return the package to the responsible commercial owner.',
      }),
      seedNode('cl-launch', 'agent', 'launch', 'Launch', 980, 180),
      seedNode('cl-observe', 'agent', 'observability', 'Revenue observability', 1280, 180),
    ],
    [
      seedEdge('cl-e1', 'cl-market', 'cl-compliance'),
      seedEdge('cl-e2', 'cl-pricing', 'cl-compliance'),
      seedEdge('cl-e3', 'cl-compliance', 'cl-approval'),
      seedEdge('cl-e4', 'cl-approval', 'cl-launch', 'approved'),
      seedEdge('cl-e5', 'cl-launch', 'cl-observe'),
    ],
  ),
  seedWorkflow(
    'incident-response',
    'Incident response',
    'Observability triggers triage, parallel customer and operational response, and a gated production change.',
    [
      seedNode('ir-observe', 'agent', 'observability', 'Observability', 60, 180),
      seedNode('ir-triage', 'agent', 'incident-triage', 'Incident triage', 340, 180),
      seedNode('ir-support', 'agent', 'support', 'Support response', 620, 70),
      seedNode('ir-devops', 'agent', 'devops-deployment', 'DevOps response', 620, 290),
      seedNode('ir-approval', 'approval', null, 'Production change approval', 920, 180, {
        requiredRole: 'Incident Commander',
        reviewCriteria: ['Impact understood', 'Mitigation tested', 'Rollback owner assigned'],
        instructions: 'Authorize the bounded production mitigation.',
        rejectionHandling: 'Continue diagnosis and use the existing contingency plan.',
      }),
      seedNode('ir-recovery', 'agent', 'testing', 'Recovery verification', 1220, 180),
    ],
    [
      seedEdge('ir-e1', 'ir-observe', 'ir-triage'),
      seedEdge('ir-e2', 'ir-triage', 'ir-support'),
      seedEdge('ir-e3', 'ir-triage', 'ir-devops'),
      seedEdge('ir-e4', 'ir-support', 'ir-approval'),
      seedEdge('ir-e5', 'ir-devops', 'ir-approval'),
      seedEdge('ir-e6', 'ir-approval', 'ir-recovery', 'approved'),
    ],
  ),
  seedWorkflow(
    'independent-operations',
    'Independent operations',
    'Four standalone agents share a canvas while operating as independent lanes.',
    [
      seedNode('io-devops', 'agent', 'devops-deployment', 'DevOps readiness', 80, 90),
      seedNode('io-support', 'agent', 'support', 'Support triage', 420, 90),
      seedNode('io-sanitize', 'agent', 'data-sanitation', 'Data sanitation', 80, 330),
      seedNode('io-observe', 'agent', 'observability', 'Observability watch', 420, 330),
    ],
    [],
  ),
]);

const AGENT_KEYS = new Set([
  'id', 'name', 'category', 'description', 'purpose', 'inputs', 'outputs', 'guardrails',
  'runtime', 'modelPreference', 'tools', 'skills', 'custom',
]);
const CONTEXT_KEYS = new Set(['id', 'name', 'description', 'custom']);

function normalizeCustomAgent(input, { strict = false } = {}) {
  if (!isRecord(input)) return { value: null, error: 'Agent profile must be an object.' };
  if (strict && !validateAllowedKeys(input, AGENT_KEYS)) {
    return { value: null, error: 'Agent profiles only accept guided fields and named tools or skills.' };
  }
  const rawText = [input.name, input.category, input.purpose ?? input.description, input.description];
  if (rawText.some(unsafeText) || [input.inputs, input.outputs, input.guardrails].some(unsafeList)) {
    return { value: null, error: 'Agent profiles cannot contain secrets, HTML, or executable code.' };
  }
  if (unsafeList(input.tools) || unsafeList(input.skills)) {
    return { value: null, error: 'Tool and skill entries must be simple identifiers.' };
  }
  const id = stableId(input.id);
  const name = plainText(input.name, 120);
  const purpose = plainText(input.purpose ?? input.description, 800);
  const description = plainText(input.description, 300) || purpose;
  if (!id) return { value: null, error: 'Agent profile ID is invalid.' };
  if (!name) return { value: null, error: 'Agent profile name is required.' };
  if (!purpose) return { value: null, error: 'Agent purpose is required.' };
  const tools = normalizeTextList(input.tools, { maxItems: 20, maxLength: 64, identifiers: true });
  const skills = normalizeTextList(input.skills, { maxItems: 20, maxLength: 64, identifiers: true });
  const sourceToolCount = Array.isArray(input.tools) ? input.tools.length : normalizeTextList(input.tools).length;
  const sourceSkillCount = Array.isArray(input.skills) ? input.skills.length : normalizeTextList(input.skills).length;
  if (strict && (tools.length !== sourceToolCount || skills.length !== sourceSkillCount)) {
    return { value: null, error: 'Tool and skill entries must be simple identifiers without arguments.' };
  }
  const runtime = AGENT_RUNTIME_OPTIONS.includes(input.runtime)
    ? input.runtime
    : 'organization-default';
  const modelPreference = AGENT_MODEL_PREFERENCES.includes(input.modelPreference)
    ? input.modelPreference
    : 'organization-default';
  return {
    value: {
      id,
      name,
      category: plainText(input.category, 80) || 'Custom',
      description,
      purpose,
      inputs: normalizeTextList(input.inputs),
      outputs: normalizeTextList(input.outputs),
      guardrails: normalizeTextList(input.guardrails),
      runtime,
      modelPreference,
      tools,
      skills,
      custom: true,
    },
    error: null,
  };
}

function normalizeCustomContext(input, { strict = false } = {}) {
  if (!isRecord(input)) return { value: null, error: 'Context profile must be an object.' };
  if (strict && !validateAllowedKeys(input, CONTEXT_KEYS)) {
    return { value: null, error: 'Contexts accept only a name and non-secret description.' };
  }
  if ([input.name, input.description].some(unsafeText)) {
    return { value: null, error: 'Contexts cannot contain secrets, HTML, or executable code.' };
  }
  const id = stableId(input.id);
  const name = plainText(input.name, 120);
  if (!id) return { value: null, error: 'Context profile ID is invalid.' };
  if (!name) return { value: null, error: 'Context name is required.' };
  return {
    value: {
      id,
      name,
      description: plainText(input.description, 600),
      custom: true,
    },
    error: null,
  };
}

function normalizeNode(input, { usedIds = new Set(), deps = {}, allowedAgentIds, allowedContextIds } = {}) {
  if (!isRecord(input) || !WORKFLOW_NODE_KINDS.includes(input.kind)) return null;
  const id = stableId(input.id) || nextId('node', usedIds, deps);
  if (usedIds.has(id)) return null;
  const kind = input.kind;
  const refId = kind === 'approval' ? null : stableId(input.refId);
  if (kind !== 'approval' && !refId) return null;
  if (kind === 'agent' && allowedAgentIds && !allowedAgentIds.has(refId)) return null;
  if (kind === 'environment' && allowedContextIds && !allowedContextIds.has(refId)) return null;
  const node = {
    id,
    kind,
    refId,
    name: plainText(input.name, 120) || (kind === 'approval' ? 'Human approval' : 'Untitled step'),
    description: plainText(input.description, 600),
    x: finiteNumber(input.x),
    y: finiteNumber(input.y),
  };
  if (kind === 'approval') {
    node.requiredRole = plainText(input.requiredRole, 120) || 'Organization Admin';
    node.reviewCriteria = normalizeTextList(input.reviewCriteria, { maxItems: 20, maxLength: 240 });
    node.instructions = plainText(input.instructions, 1_000);
    node.rejectionHandling = plainText(input.rejectionHandling, 1_000);
  }
  return node;
}

function pathExists(edges, start, goal) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source).push(edge.target);
  }
  const stack = [start];
  const visited = new Set();
  while (stack.length) {
    const nodeId = stack.pop();
    if (nodeId === goal) return true;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    stack.push(...(adjacency.get(nodeId) || []));
  }
  return false;
}

function normalizeEdges(rawEdges, nodes, deps = {}) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const usedIds = new Set();
  const pairs = new Set();
  const edges = [];
  for (const raw of (Array.isArray(rawEdges) ? rawEdges : []).slice(0, MAX_EDGES)) {
    if (!isRecord(raw)) continue;
    const source = stableId(raw.source);
    const target = stableId(raw.target);
    const pair = `${source}\u0000${target}`;
    if (!nodeIds.has(source) || !nodeIds.has(target) || source === target || pairs.has(pair)) continue;
    if (pathExists(edges, target, source)) continue;
    const id = stableId(raw.id) || nextId('edge', usedIds, deps);
    if (usedIds.has(id)) continue;
    const edge = { id, source, target };
    if (APPROVAL_EDGE_OUTCOMES.includes(raw.outcome) && nodeById.get(source).kind === 'approval') {
      edge.outcome = raw.outcome;
    }
    usedIds.add(id);
    pairs.add(pair);
    edges.push(edge);
  }
  return edges;
}

function normalizeWorkflowInternal(input, options = {}) {
  if (!isRecord(input)) return null;
  const fallbackTime = options.fallbackTime || timestamp(options.deps);
  const id = stableId(input.id);
  const name = plainText(input.name, 160);
  if (!id || !name) return null;
  const nodeIds = new Set();
  const nodes = [];
  for (const rawNode of (Array.isArray(input.nodes) ? input.nodes : []).slice(0, MAX_NODES)) {
    const node = normalizeNode(rawNode, {
      usedIds: nodeIds,
      deps: options.deps,
      allowedAgentIds: options.allowedAgentIds,
      allowedContextIds: options.allowedContextIds,
    });
    if (!node) continue;
    nodeIds.add(node.id);
    nodes.push(node);
  }
  const createdAt = normalizeTimestamp(input.createdAt, fallbackTime);
  const workflow = {
    id,
    name,
    description: plainText(input.description, 1_000),
    createdAt,
    updatedAt: normalizeTimestamp(input.updatedAt, createdAt),
    viewport: {
      x: finiteNumber(input.viewport && input.viewport.x),
      y: finiteNumber(input.viewport && input.viewport.y),
      zoom: finiteNumber(input.viewport && input.viewport.zoom, 1, 0.2, 3),
    },
    nodes,
    edges: normalizeEdges(input.edges, nodes, options.deps),
  };
  const exampleId = stableId(input.exampleId);
  const sourceExampleId = stableId(input.sourceExampleId);
  if (exampleId) workflow.exampleId = exampleId;
  if (input.isExample === true && exampleId) workflow.isExample = true;
  if (sourceExampleId) workflow.sourceExampleId = sourceExampleId;
  return workflow;
}

/** Normalize one workflow. Custom reference validation is intentionally left to normalizeState. */
export function normalizeWorkflow(input, deps = {}) {
  return normalizeWorkflowInternal(input, { deps });
}

function seededWorkflowClones() {
  return clone(SEEDED_WORKFLOWS);
}

export function createInitialState() {
  const workflows = seededWorkflowClones();
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    activeWorkflowId: workflows[0].id,
    workflows,
    customAgents: [],
    customContexts: [],
  };
}

function normalizeStateWithRecovery(raw, deps = {}) {
  if (!isRecord(raw) || raw.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    return { state: createInitialState(), recovered: true };
  }
  const curatedAgentIds = new Set(CURATED_AGENT_CATALOG.map((item) => item.id));
  const builtInContextIds = new Set(BUILT_IN_CONTEXT_CATALOG.map((item) => item.id));
  const customAgents = [];
  const agentIds = new Set(curatedAgentIds);
  for (const rawAgent of (Array.isArray(raw.customAgents) ? raw.customAgents : []).slice(0, MAX_CUSTOM_PROFILES)) {
    const result = normalizeCustomAgent(rawAgent);
    if (!result.value || agentIds.has(result.value.id)) continue;
    agentIds.add(result.value.id);
    customAgents.push(result.value);
  }
  const customContexts = [];
  const contextIds = new Set(builtInContextIds);
  for (const rawContext of (Array.isArray(raw.customContexts) ? raw.customContexts : []).slice(0, MAX_CUSTOM_PROFILES)) {
    const result = normalizeCustomContext(rawContext);
    if (!result.value || contextIds.has(result.value.id)) continue;
    contextIds.add(result.value.id);
    customContexts.push(result.value);
  }
  const workflowIds = new Set();
  const workflows = [];
  const rawWorkflows = Array.isArray(raw.workflows) ? raw.workflows : null;
  if (rawWorkflows) {
    for (const rawWorkflow of rawWorkflows.slice(0, MAX_WORKFLOWS)) {
      const workflow = normalizeWorkflowInternal(rawWorkflow, {
        deps,
        allowedAgentIds: agentIds,
        allowedContextIds: contextIds,
      });
      if (!workflow || workflowIds.has(workflow.id)) continue;
      workflowIds.add(workflow.id);
      workflows.push(workflow);
    }
  }
  const invalidWorkflowCollection = !rawWorkflows || workflows.length === 0;
  const resolvedWorkflows = invalidWorkflowCollection ? seededWorkflowClones() : workflows;
  const activeId = stableId(raw.activeWorkflowId);
  const activeWorkflowId = resolvedWorkflows.some((workflow) => workflow.id === activeId)
    ? activeId
    : resolvedWorkflows[0]?.id || null;
  const state = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    activeWorkflowId,
    workflows: resolvedWorkflows,
    customAgents,
    customContexts,
  };
  let recovered = invalidWorkflowCollection;
  try {
    recovered ||= JSON.stringify(state) !== JSON.stringify(raw);
  } catch (_) {
    recovered = true;
  }
  return { state, recovered };
}

/** Return a fresh, plain and safe state object. */
export function normalizeState(raw, deps = {}) {
  return normalizeStateWithRecovery(raw, deps).state;
}

export function serializeState(state) {
  return JSON.stringify(normalizeState(state));
}

export function rehydrateState(serialized, deps = {}) {
  if (typeof serialized !== 'string' || !serialized.trim()) {
    return { state: createInitialState(), recovered: false, error: null };
  }
  try {
    const normalized = normalizeStateWithRecovery(JSON.parse(serialized), deps);
    return { ...normalized, error: normalized.recovered ? 'Stored workflow data was repaired.' : null };
  } catch (_) {
    return { state: createInitialState(), recovered: true, error: 'Stored workflow data was unreadable.' };
  }
}

export function storageKeyForOrganization(organizationId) {
  const id = stableId(organizationId);
  return id ? `${WORKFLOW_STORAGE_PREFIX}${id}` : '';
}

export function readStateFromStorage(storage, organizationId, deps = {}) {
  const key = storageKeyForOrganization(organizationId);
  if (!key) return { state: createInitialState(), recovered: true, error: 'Organization ID is invalid.', key };
  if (!storage || typeof storage.getItem !== 'function') {
    return { state: createInitialState(), recovered: true, error: 'Local storage is unavailable.', key };
  }
  try {
    return { ...rehydrateState(storage.getItem(key), deps), key };
  } catch (_) {
    return { state: createInitialState(), recovered: true, error: 'Local storage could not be read.', key };
  }
}

export function writeStateToStorage(storage, organizationId, state) {
  const key = storageKeyForOrganization(organizationId);
  if (!key) return { ok: false, key, error: 'Organization ID is invalid.' };
  if (!storage || typeof storage.setItem !== 'function') {
    return { ok: false, key, error: 'Local storage is unavailable.' };
  }
  try {
    storage.setItem(key, serializeState(state));
    return { ok: true, key, error: null };
  } catch (_) {
    return { ok: false, key, error: 'Workflow changes could not be saved locally.' };
  }
}

export function getAgentCatalog(state) {
  return clone([
    ...CURATED_AGENT_CATALOG,
    ...(Array.isArray(state?.customAgents) ? state.customAgents : []),
  ]);
}

export function getContextCatalog(state) {
  return clone([
    ...BUILT_IN_CONTEXT_CATALOG,
    ...(Array.isArray(state?.customContexts) ? state.customContexts : []),
  ]);
}

export function findAgentProfile(id, state) {
  const profile = getAgentCatalog(state).find((item) => item.id === stableId(id));
  return profile || null;
}

export function findContextProfile(id, state) {
  const profile = getContextCatalog(state).find((item) => item.id === stableId(id));
  return profile || null;
}

export function createWorkflow(input = {}, deps = {}) {
  const now = timestamp(deps);
  const id = stableId(input.id) || nextId('workflow', new Set(), deps);
  return normalizeWorkflowInternal({
    id,
    name: plainText(input.name, 160) || 'Untitled workflow',
    description: input.description || '',
    createdAt: now,
    updatedAt: now,
    viewport: input.viewport || { x: 40, y: 40, zoom: 1 },
    nodes: input.nodes || [],
    edges: input.edges || [],
    sourceExampleId: input.sourceExampleId,
  }, { deps, fallbackTime: now });
}

export function cloneWorkflow(source, overrides = {}, deps = {}) {
  const sourceWorkflow = normalizeWorkflow(source, deps);
  if (!sourceWorkflow) return null;
  const requestedWorkflowId = stableId(overrides.id);
  const workflowId = requestedWorkflowId && requestedWorkflowId !== sourceWorkflow.id
    ? requestedWorkflowId
    : nextId('workflow', new Set([sourceWorkflow.id]), deps);
  const used = new Set();
  const nodeIdMap = new Map();
  const nodes = sourceWorkflow.nodes.map((node) => {
    const id = nextId('node', used, deps);
    used.add(id);
    nodeIdMap.set(node.id, id);
    return { ...clone(node), id };
  });
  const edgeIds = new Set();
  const edges = sourceWorkflow.edges.map((edge) => {
    const id = nextId('edge', edgeIds, deps);
    edgeIds.add(id);
    return {
      ...clone(edge),
      id,
      source: nodeIdMap.get(edge.source),
      target: nodeIdMap.get(edge.target),
    };
  });
  return createWorkflow({
    id: workflowId,
    name: overrides.name || `${sourceWorkflow.name} copy`,
    description: overrides.description ?? sourceWorkflow.description,
    viewport: clone(sourceWorkflow.viewport),
    nodes,
    edges,
    sourceExampleId: sourceWorkflow.exampleId || sourceWorkflow.sourceExampleId,
  }, deps);
}

export function upsertWorkflow(state, input, deps = {}) {
  const safeState = normalizeState(state, deps);
  const agentIds = new Set(getAgentCatalog(safeState).map((item) => item.id));
  const contextIds = new Set(getContextCatalog(safeState).map((item) => item.id));
  const workflow = normalizeWorkflowInternal(input, {
    deps,
    allowedAgentIds: agentIds,
    allowedContextIds: contextIds,
  });
  if (!workflow) return { ok: false, state: safeState, workflow: null, error: 'Workflow is invalid.' };
  const workflows = safeState.workflows.slice();
  const index = workflows.findIndex((item) => item.id === workflow.id);
  if (index >= 0) workflows[index] = workflow;
  else if (workflows.length >= MAX_WORKFLOWS) {
    return { ok: false, state: safeState, workflow: null, error: 'Workflow limit reached.' };
  } else workflows.push(workflow);
  return {
    ok: true,
    state: { ...safeState, activeWorkflowId: workflow.id, workflows },
    workflow: clone(workflow),
    error: null,
  };
}

export function deleteWorkflow(state, workflowId, deps = {}) {
  const safeState = normalizeState(state, deps);
  const id = stableId(workflowId);
  const index = safeState.workflows.findIndex((item) => item.id === id);
  if (index < 0) return { ok: false, state: safeState, workflow: null, error: 'Workflow was not found.' };
  if (safeState.workflows.length === 1) {
    return { ok: false, state: safeState, workflow: null, error: 'Keep at least one workflow.' };
  }
  const workflow = safeState.workflows[index];
  const workflows = safeState.workflows.filter((item) => item.id !== id);
  const activeWorkflowId = safeState.activeWorkflowId === id
    ? workflows[Math.min(index, workflows.length - 1)]?.id || null
    : safeState.activeWorkflowId;
  return {
    ok: true,
    state: { ...safeState, activeWorkflowId, workflows },
    workflow: clone(workflow),
    error: null,
  };
}

export function resetSeededWorkflows(state, deps = {}) {
  const safeState = normalizeState(state, deps);
  const customWorkflows = safeState.workflows.filter((workflow) => !workflow.isExample);
  if (customWorkflows.length + SEEDED_WORKFLOWS.length > MAX_WORKFLOWS) {
    return {
      ok: false,
      state: safeState,
      error: `Keep at most ${MAX_WORKFLOWS - SEEDED_WORKFLOWS.length} custom workflows before resetting examples.`,
    };
  }
  const workflows = [...seededWorkflowClones(), ...customWorkflows];
  const activeWorkflowId = workflows.some((workflow) => workflow.id === safeState.activeWorkflowId)
    ? safeState.activeWorkflowId
    : workflows[0]?.id || null;
  return { ok: true, state: { ...safeState, activeWorkflowId, workflows }, error: null };
}

function mutationWorkflow(workflow) {
  if (!isRecord(workflow)) return null;
  const result = clone(workflow);
  result.nodes = Array.isArray(result.nodes) ? result.nodes : [];
  result.edges = Array.isArray(result.edges) ? result.edges : [];
  return result;
}

function touch(workflow, deps) {
  return { ...workflow, updatedAt: timestamp(deps) };
}

export function addNode(workflow, input, deps = {}) {
  const next = mutationWorkflow(workflow);
  if (!next) return { ok: false, workflow, node: null, error: 'Workflow is invalid.' };
  if (next.nodes.length >= MAX_NODES) return { ok: false, workflow: next, node: null, error: 'Node limit reached.' };
  const usedIds = new Set(next.nodes.map((node) => node.id));
  const node = normalizeNode({ ...input, id: stableId(input?.id) || nextId('node', usedIds, deps) }, { usedIds, deps });
  if (!node) return { ok: false, workflow: next, node: null, error: 'Node is invalid or its ID is already used.' };
  next.nodes.push(node);
  const updated = touch(next, deps);
  return { ok: true, workflow: updated, node: clone(node), error: null };
}

export function updateNode(workflow, nodeId, patch, deps = {}) {
  const next = mutationWorkflow(workflow);
  const id = stableId(nodeId);
  const index = next?.nodes.findIndex((node) => node.id === id) ?? -1;
  if (index < 0) return { ok: false, workflow: next || workflow, node: null, error: 'Node was not found.' };
  const usedIds = new Set(next.nodes.filter((_, itemIndex) => itemIndex !== index).map((node) => node.id));
  const node = normalizeNode({ ...next.nodes[index], ...(isRecord(patch) ? patch : {}), id }, { usedIds, deps });
  if (!node) return { ok: false, workflow: next, node: null, error: 'Node update is invalid.' };
  const outgoing = next.edges.filter((edge) => edge.source === id);
  if (node.kind !== 'approval' && outgoing.some((edge) => edge.outcome)) {
    return { ok: false, workflow: next, node: null, error: 'Only approval nodes can own outcome-labelled edges.' };
  }
  next.nodes[index] = node;
  const updated = touch(next, deps);
  return { ok: true, workflow: updated, node: clone(node), error: null };
}

export function moveNode(workflow, nodeId, position, deps = {}) {
  return updateNode(workflow, nodeId, {
    x: finiteNumber(position?.x),
    y: finiteNumber(position?.y),
  }, deps);
}

export function deleteNode(workflow, nodeId, deps = {}) {
  const next = mutationWorkflow(workflow);
  const id = stableId(nodeId);
  const index = next?.nodes.findIndex((node) => node.id === id) ?? -1;
  if (index < 0) return { ok: false, workflow: next || workflow, node: null, error: 'Node was not found.' };
  const [node] = next.nodes.splice(index, 1);
  next.edges = next.edges.filter((edge) => edge.source !== id && edge.target !== id);
  const updated = touch(next, deps);
  return { ok: true, workflow: updated, node, error: null };
}

export function wouldCreateCycle(workflow, source, target) {
  const sourceId = stableId(source);
  const targetId = stableId(target);
  if (!sourceId || !targetId || sourceId === targetId) return true;
  return pathExists(Array.isArray(workflow?.edges) ? workflow.edges : [], targetId, sourceId);
}

export function addEdge(workflow, input, deps = {}) {
  const next = mutationWorkflow(workflow);
  if (!next || !isRecord(input)) return { ok: false, workflow: next || workflow, edge: null, error: 'Edge is invalid.' };
  if (next.edges.length >= MAX_EDGES) return { ok: false, workflow: next, edge: null, error: 'Edge limit reached.' };
  const source = stableId(input.source);
  const target = stableId(input.target);
  const sourceNode = next.nodes.find((node) => node.id === source);
  const targetNode = next.nodes.find((node) => node.id === target);
  if (!sourceNode || !targetNode) return { ok: false, workflow: next, edge: null, error: 'Both edge endpoints must exist.' };
  if (source === target) return { ok: false, workflow: next, edge: null, error: 'A node cannot depend on itself.' };
  if (next.edges.some((edge) => edge.source === source && edge.target === target)) {
    return { ok: false, workflow: next, edge: null, error: 'That connection already exists.' };
  }
  if (wouldCreateCycle(next, source, target)) {
    return { ok: false, workflow: next, edge: null, error: 'That connection would create a cycle.' };
  }
  if (input.outcome && (!APPROVAL_EDGE_OUTCOMES.includes(input.outcome) || sourceNode.kind !== 'approval')) {
    return { ok: false, workflow: next, edge: null, error: 'Outcome labels are only valid on approval connections.' };
  }
  const usedIds = new Set(next.edges.map((edge) => edge.id));
  const requestedId = stableId(input.id);
  if (requestedId && usedIds.has(requestedId)) {
    return { ok: false, workflow: next, edge: null, error: 'Edge ID is already used.' };
  }
  const edge = {
    id: requestedId || nextId('edge', usedIds, deps),
    source,
    target,
    ...(input.outcome ? { outcome: input.outcome } : {}),
  };
  next.edges.push(edge);
  const updated = touch(next, deps);
  return { ok: true, workflow: updated, edge: clone(edge), error: null };
}

export function updateEdge(workflow, edgeId, patch, deps = {}) {
  const next = mutationWorkflow(workflow);
  const id = stableId(edgeId);
  const index = next?.edges.findIndex((edge) => edge.id === id) ?? -1;
  if (index < 0) return { ok: false, workflow: next || workflow, edge: null, error: 'Connection was not found.' };
  const original = next.edges[index];
  next.edges.splice(index, 1);
  const result = addEdge(next, { ...original, ...(isRecord(patch) ? patch : {}), id }, deps);
  if (!result.ok) return { ...result, workflow: mutationWorkflow(workflow) };
  return result;
}

export function deleteEdge(workflow, edgeId, deps = {}) {
  const next = mutationWorkflow(workflow);
  const id = stableId(edgeId);
  const index = next?.edges.findIndex((edge) => edge.id === id) ?? -1;
  if (index < 0) return { ok: false, workflow: next || workflow, edge: null, error: 'Connection was not found.' };
  const [edge] = next.edges.splice(index, 1);
  const updated = touch(next, deps);
  return { ok: true, workflow: updated, edge, error: null };
}

export function graphSummary(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const neighbors = new Map(nodes.map((node) => [node.id, new Set()]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    neighbors.get(edge.source).add(edge.target);
    neighbors.get(edge.target).add(edge.source);
    indegree.set(edge.target, indegree.get(edge.target) + 1);
  }
  const visited = new Set();
  const components = [];
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    const stack = [node.id];
    const componentNodeIds = [];
    while (stack.length) {
      const id = stack.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      componentNodeIds.push(id);
      stack.push(...neighbors.get(id));
    }
    const componentSet = new Set(componentNodeIds);
    components.push({
      nodeIds: componentNodeIds,
      edgeIds: edges
        .filter((edge) => componentSet.has(edge.source) && componentSet.has(edge.target))
        .map((edge) => edge.id),
    });
  }
  return {
    componentCount: components.length,
    components,
    standaloneNodeIds: nodes.filter((node) => neighbors.get(node.id).size === 0).map((node) => node.id),
    rootNodeIds: nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id),
  };
}

function replaceProfileReferences(state, kind, profileId, profile, deps) {
  const now = timestamp(deps);
  return state.workflows.map((workflow) => {
    let changed = false;
    const nodes = workflow.nodes.map((node) => {
      if (node.kind !== kind || node.refId !== profileId) return node;
      changed = true;
      return { ...node, name: profile.name, description: profile.description || profile.purpose || '' };
    });
    return changed ? { ...workflow, nodes, updatedAt: now } : workflow;
  });
}

export function createCustomAgent(state, input, deps = {}) {
  const safeState = normalizeState(state, deps);
  if (safeState.customAgents.length >= MAX_CUSTOM_PROFILES) {
    return { ok: false, state: safeState, agent: null, error: 'Custom agent profile limit reached.' };
  }
  const ids = new Set(getAgentCatalog(safeState).map((item) => item.id));
  const requestedId = stableId(input?.id);
  const result = normalizeCustomAgent({
    ...(isRecord(input) ? input : {}),
    id: requestedId || nextId('custom-agent', ids, deps),
    custom: true,
  }, { strict: true });
  if (!result.value) return { ok: false, state: safeState, agent: null, error: result.error };
  if (ids.has(result.value.id)) return { ok: false, state: safeState, agent: null, error: 'Agent profile ID is already used.' };
  const agentProfile = result.value;
  return {
    ok: true,
    state: { ...safeState, customAgents: [...safeState.customAgents, agentProfile] },
    agent: clone(agentProfile),
    error: null,
  };
}

export function updateCustomAgent(state, agentId, patch, deps = {}) {
  const safeState = normalizeState(state, deps);
  const id = stableId(agentId);
  const index = safeState.customAgents.findIndex((item) => item.id === id);
  if (index < 0) return { ok: false, state: safeState, agent: null, error: 'Custom agent profile was not found.' };
  const result = normalizeCustomAgent({
    ...safeState.customAgents[index],
    ...(isRecord(patch) ? patch : {}),
    id,
    custom: true,
  }, { strict: true });
  if (!result.value) return { ok: false, state: safeState, agent: null, error: result.error };
  const customAgents = safeState.customAgents.slice();
  customAgents[index] = result.value;
  const nextState = {
    ...safeState,
    customAgents,
    workflows: replaceProfileReferences(safeState, 'agent', id, result.value, deps),
  };
  return { ok: true, state: nextState, agent: clone(result.value), error: null };
}

export function duplicateAgentProfile(state, agentId, overrides = {}, deps = {}) {
  const profile = findAgentProfile(agentId, state);
  if (!profile) return { ok: false, state: normalizeState(state, deps), agent: null, error: 'Agent profile was not found.' };
  return createCustomAgent(state, {
    ...profile,
    ...overrides,
    id: overrides.id,
    name: overrides.name || `${profile.name} copy`,
    custom: true,
  }, deps);
}

export function deleteCustomAgent(state, agentId, deps = {}) {
  const safeState = normalizeState(state, deps);
  const id = stableId(agentId);
  const index = safeState.customAgents.findIndex((item) => item.id === id);
  if (index < 0) return { ok: false, state: safeState, agent: null, error: 'Custom agent profile was not found.' };
  const references = safeState.workflows.reduce(
    (count, workflow) => count + workflow.nodes.filter((node) => node.kind === 'agent' && node.refId === id).length,
    0,
  );
  if (references) {
    return { ok: false, state: safeState, agent: null, error: `Agent profile is used by ${references} workflow node(s).` };
  }
  const [agentProfile] = safeState.customAgents.splice(index, 1);
  return { ok: true, state: safeState, agent: agentProfile, error: null };
}

export function createCustomContext(state, input, deps = {}) {
  const safeState = normalizeState(state, deps);
  if (safeState.customContexts.length >= MAX_CUSTOM_PROFILES) {
    return { ok: false, state: safeState, context: null, error: 'Custom context profile limit reached.' };
  }
  const ids = new Set(getContextCatalog(safeState).map((item) => item.id));
  const requestedId = stableId(input?.id);
  const result = normalizeCustomContext({
    ...(isRecord(input) ? input : {}),
    id: requestedId || nextId('custom-context', ids, deps),
    custom: true,
  }, { strict: true });
  if (!result.value) return { ok: false, state: safeState, context: null, error: result.error };
  if (ids.has(result.value.id)) return { ok: false, state: safeState, context: null, error: 'Context profile ID is already used.' };
  const context = result.value;
  return {
    ok: true,
    state: { ...safeState, customContexts: [...safeState.customContexts, context] },
    context: clone(context),
    error: null,
  };
}

export function updateCustomContext(state, contextId, patch, deps = {}) {
  const safeState = normalizeState(state, deps);
  const id = stableId(contextId);
  const index = safeState.customContexts.findIndex((item) => item.id === id);
  if (index < 0) return { ok: false, state: safeState, context: null, error: 'Custom context was not found.' };
  const result = normalizeCustomContext({
    ...safeState.customContexts[index],
    ...(isRecord(patch) ? patch : {}),
    id,
    custom: true,
  }, { strict: true });
  if (!result.value) return { ok: false, state: safeState, context: null, error: result.error };
  const customContexts = safeState.customContexts.slice();
  customContexts[index] = result.value;
  const nextState = {
    ...safeState,
    customContexts,
    workflows: replaceProfileReferences(safeState, 'environment', id, result.value, deps),
  };
  return { ok: true, state: nextState, context: clone(result.value), error: null };
}

export function deleteCustomContext(state, contextId, deps = {}) {
  const safeState = normalizeState(state, deps);
  const id = stableId(contextId);
  const index = safeState.customContexts.findIndex((item) => item.id === id);
  if (index < 0) return { ok: false, state: safeState, context: null, error: 'Custom context was not found.' };
  const references = safeState.workflows.reduce(
    (count, workflow) => count + workflow.nodes.filter((node) => node.kind === 'environment' && node.refId === id).length,
    0,
  );
  if (references) {
    return { ok: false, state: safeState, context: null, error: `Context is used by ${references} workflow node(s).` };
  }
  const [context] = safeState.customContexts.splice(index, 1);
  return { ok: true, state: safeState, context, error: null };
}
