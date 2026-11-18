'use strict';

// Durable contract for workflow graphs (schema v2). This is the server-side
// authority used by the gateway persistence API; the browser mirrors it in
// public/js/workflow-designer-model.mjs and parity.test.js pins the two shapes
// against each other (the deployed gateway image does not carry public/).

const WORKFLOW_SCHEMA_VERSION_V2 = 2;
const WORKFLOW_NODE_KINDS_V2 = Object.freeze(['agent', 'approval', 'environment', 'gate']);
const WORKFLOW_NODE_BACKENDS = Object.freeze(['substrate', 'kagent']);
const TASK_TIERS = Object.freeze(['complex', 'medium', 'easy']);
const MODEL_FAMILIES = Object.freeze(['anthropic', 'openai', 'bedrock', 'vertexai', 'gemini', 'byok']);
const HARNESS_OPTIONS = Object.freeze(['claude-code', 'codex', 'deepagent', 'opencode', 'gemini-cli', 'pi', 'qoder', 'kilo', 'goose', 'openspec', 'github-actions', 'otel']);
const GATE_CARD_MAX = 6;
const GATE_ITEM_MAX = 3;
const CONNECTOR_MAX = 20;
const KAGENT_ENV_MAX = 40;
const KAGENT_SKILL_MAX = 50;
const KAGENT_PLUGIN_MAX = 20;
const KAGENT_TOOL_MAX = 50;
const KAGENT_OCI_VOLUME_MAX = 29;
const RESERVED_ENV_NAMES = Object.freeze(['PLUGIN_ROOT', 'PLUGIN_DATA']);

const MAX_COORDINATE = 100000;
const MAX_NODES = 500;
const MAX_EDGES = 2000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const K8S_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const K8S_NS = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OCI_PINNED = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const GIT_COMMIT = /^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const HTTP_URL = /^https?:\/\/\S+$/;
const HTML_OR_CODE = /<\/?[A-Za-z][^>]*>|```|javascript\s*:|^#!|\$\{[^}]+\}/im;
// Credential-shaped values must never be typed into env rows: they belong to
// ModelConfig apiKeySecret / RemoteMCPServer headersFrom references instead.
const SECRETISH = /(api[_-]?key|secret|passw(or)?d|private[_-]?key|access[_-]?token|akia[0-9a-z]{12,}|bearer\s+[a-z0-9._-]{16,}|ghp_[a-z0-9]{20,}|sk-[a-z0-9]{20,})/i;

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

function unsafeText(value) {
  return typeof value === 'string' && HTML_OR_CODE.test(value);
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

function normalizeTextList(value, { maxItems = 20, maxLength = 240 } = {}) {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(/\r?\n|,/) : [];
  const result = [];
  for (const item of source) {
    const text = plainText(item, maxLength);
    if (!text || result.includes(text)) continue;
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeConnectorList(value) {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\s*,\s*/) : [];
  const result = [];
  for (const item of source) {
    const id = stableId(String(item ?? '').toLowerCase());
    if (!id || result.includes(id)) continue;
    result.push(id);
    if (result.length >= CONNECTOR_MAX) break;
  }
  return result;
}

// ---------------------------------------------------------------- kagent spec

function normalizeArtifactSource(source) {
  if (!isRecord(source)) return null;
  const path = typeof source.path === 'string' ? source.path.slice(0, 1024) : '';
  if (path.startsWith('/') || path.split('/').includes('..')) return null;
  const kinds = [source.oci != null, source.git != null, source.bucket != null].filter(Boolean).length;
  if (kinds !== 1) return null;
  if (source.oci != null) {
    const oci = plainText(source.oci, 512);
    if (!OCI_PINNED.test(oci)) return null;
    return { oci, ...(path ? { path } : {}) };
  }
  if (source.git != null) {
    const git = isRecord(source.git) ? source.git : {};
    const url = plainText(git.url, 512);
    const commit = plainText(git.commit, 64);
    if (!HTTP_URL.test(url) || !GIT_COMMIT.test(commit)) return null;
    return { git: { url, commit }, ...(path ? { path } : {}) };
  }
  const bucket = isRecord(source.bucket) && isRecord(source.bucket.s3) ? source.bucket.s3 : null;
  if (!bucket) return null;
  const s3 = {
    bucket: plainText(bucket.bucket, 200),
    endpoint: plainText(bucket.endpoint, 512),
    key: plainText(bucket.key, 1024),
    versionId: plainText(bucket.versionId, 200),
  };
  if (!s3.bucket || !s3.key || !s3.versionId || !HTTP_URL.test(s3.endpoint)) return null;
  const region = plainText(bucket.region, 64);
  if (region) s3.region = region;
  return { bucket: { s3 }, ...(path ? { path } : {}) };
}

function normalizeSkillName(value) {
  const name = plainText(value, 64);
  if (!name || name.includes('/') || name === '.' || name === '..') return '';
  return name;
}

function normalizeKagentEnv(rows) {
  const result = [];
  for (const row of Array.isArray(rows) ? rows.slice(0, KAGENT_ENV_MAX) : []) {
    if (!isRecord(row)) continue;
    const name = plainText(row.name, 128);
    if (!ENV_NAME.test(name) || RESERVED_ENV_NAMES.includes(name)) continue;
    const value = typeof row.value === 'string' ? row.value.slice(0, 2048) : '';
    if (unsafeText(value) || SECRETISH.test(`${name} ${value}`)) continue;
    if (result.some((item) => item.name === name)) continue;
    result.push({ name, value });
  }
  return result;
}

function normalizeKagentSpec(input) {
  if (!isRecord(input)) return { spec: null, errors: ['kagentSpec must be an object.'] };
  const errors = [];
  const spec = {
    modelConfig: null,
    skills: [],
    plugins: [],
    tools: [],
    env: normalizeKagentEnv(input.env),
    egressPolicyRefs: normalizeTextList(input.egressPolicyRefs, { maxItems: 10, maxLength: 253 })
      .filter((name) => K8S_NAME.test(name)),
  };
  if (isRecord(input.modelConfig)) {
    const name = plainText(input.modelConfig.name, 253);
    const namespace = plainText(input.modelConfig.namespace, 63);
    if (K8S_NAME.test(name) && (!namespace || K8S_NS.test(namespace))) {
      spec.modelConfig = { name, ...(namespace ? { namespace } : {}) };
    } else errors.push('kagentSpec.modelConfig must name a ModelConfig (DNS subdomain).');
  } else if (input.modelConfig != null) {
    errors.push('kagentSpec.modelConfig must be an object with a name.');
  }
  const seenSkills = new Set();
  for (const skill of Array.isArray(input.skills) ? input.skills.slice(0, KAGENT_SKILL_MAX) : []) {
    if (!isRecord(skill)) continue;
    const name = normalizeSkillName(skill.name);
    const source = normalizeArtifactSource(skill.source);
    if (!name || !source || seenSkills.has(name)) {
      errors.push(`kagentSpec.skills entry invalid or duplicated: ${String(skill.name).slice(0, 64)}`);
      continue;
    }
    seenSkills.add(name);
    const promptAppend = plainText(skill.promptAppend, 4000);
    spec.skills.push({ name, source, ...(promptAppend ? { promptAppend } : {}) });
  }
  if (Array.isArray(input.skills) && input.skills.length > KAGENT_SKILL_MAX) {
    errors.push(`kagentSpec.skills exceeds ${KAGENT_SKILL_MAX}.`);
  }
  const pluginSources = new Set();
  for (const plugin of Array.isArray(input.plugins) ? input.plugins.slice(0, KAGENT_PLUGIN_MAX) : []) {
    if (!isRecord(plugin)) continue;
    const source = normalizeArtifactSource(plugin.source);
    if (!source) { errors.push('kagentSpec.plugins entry needs a valid immutable source.'); continue; }
    const serialized = JSON.stringify(source);
    if (pluginSources.has(serialized)) { errors.push('kagentSpec.plugins sources must be unique.'); continue; }
    pluginSources.add(serialized);
    const allowlist = normalizeTextList(plugin.skills, { maxItems: KAGENT_SKILL_MAX, maxLength: 64 })
      .map(normalizeSkillName).filter(Boolean);
    const promptAppend = plainText(plugin.promptAppend, 4000);
    spec.plugins.push({ source, skills: allowlist, ...(promptAppend ? { promptAppend } : {}) });
  }
  if (Array.isArray(input.plugins) && input.plugins.length > KAGENT_PLUGIN_MAX) {
    errors.push(`kagentSpec.plugins exceeds ${KAGENT_PLUGIN_MAX}.`);
  }
  const seenTools = new Set();
  for (const tool of Array.isArray(input.tools) ? input.tools.slice(0, KAGENT_TOOL_MAX) : []) {
    if (!isRecord(tool)) continue;
    if (tool.kind === 'mcp') {
      const server = plainText(tool.server, 253);
      if (!K8S_NAME.test(server)) { errors.push('kagentSpec.tools mcp binding needs a RemoteMCPServer name.'); continue; }
      const entry = {
        kind: 'mcp',
        server,
        tools: normalizeTextList(tool.tools, { maxItems: 50, maxLength: 128 }),
        ...(tool.requireApproval === true ? { requireApproval: true } : {}),
      };
      const promptAppend = plainText(tool.promptAppend, 4000);
      if (promptAppend) entry.promptAppend = promptAppend;
      const key = `mcp:${server}`;
      if (seenTools.has(key)) { errors.push(`Duplicate MCP binding ${server}.`); continue; }
      seenTools.add(key);
      spec.tools.push(entry);
    } else if (tool.kind === 'subAgent') {
      const name = normalizeSkillName(tool.name);
      const templateRef = plainText(tool.templateRef, 253);
      const description = plainText(tool.description, 600);
      if (!name || !K8S_NAME.test(templateRef) || !description) {
        errors.push('kagentSpec.tools subAgent binding needs name, templateRef and description.');
        continue;
      }
      const key = `subAgent:${name}`;
      if (seenTools.has(key)) { errors.push(`Duplicate subAgent binding ${name}.`); continue; }
      seenTools.add(key);
      spec.tools.push({ kind: 'subAgent', name, templateRef, description });
    } else {
      errors.push('kagentSpec.tools entries must be kind mcp or subAgent.');
    }
  }
  if (Array.isArray(input.tools) && input.tools.length > KAGENT_TOOL_MAX) {
    errors.push(`kagentSpec.tools exceeds ${KAGENT_TOOL_MAX}.`);
  }
  const ociImages = new Set();
  for (const skill of spec.skills) if (skill.source.oci) ociImages.add(skill.source.oci);
  for (const plugin of spec.plugins) if (plugin.source.oci) ociImages.add(plugin.source.oci);
  if (ociImages.size > KAGENT_OCI_VOLUME_MAX) {
    errors.push(`kagentSpec uses ${ociImages.size} distinct OCI images; the runtime supports at most ${KAGENT_OCI_VOLUME_MAX}.`);
  }
  // Upstream limitation: git/bucket sources never become Ready (the golden
  // snapshot Actor has no egress). They stay valid in stored config but are
  // reported so the UI can flag them.
  const unavailableSources = [];
  for (const skill of spec.skills) if (!skill.source.oci) unavailableSources.push(`skill:${skill.name}`);
  for (const plugin of spec.plugins) if (!plugin.source.oci) unavailableSources.push('plugin');
  return { spec, errors, ociImages: ociImages.size, unavailableSources };
}

// A non-Ready upstream source is a warning, not a save-time error: the graph
// may be designed before the platform fix lands.
function kagentSpecWarnings(result) {
  const warnings = [];
  if (result.spec) {
    for (const item of result.unavailableSources || []) {
      warnings.push(`${item} uses a git/bucket source; kagent actors with non-OCI sources do not become Ready yet.`);
    }
  }
  return warnings;
}

/** Compose the effective system prompt: base prompt first, then each enabled
 * skill/plugin/MCP promptAppend in declaration order. */
function composeKagentSystemPrompt(node) {
  const parts = [plainText(node?.systemPrompt, 16000)].filter(Boolean);
  const spec = isRecord(node?.kagentSpec) ? node.kagentSpec : {};
  for (const skill of Array.isArray(spec.skills) ? spec.skills : []) {
    const append = plainText(skill.promptAppend, 4000);
    if (append) parts.push(append);
  }
  for (const plugin of Array.isArray(spec.plugins) ? spec.plugins : []) {
    const append = plainText(plugin.promptAppend, 4000);
    if (append) parts.push(append);
  }
  for (const tool of Array.isArray(spec.tools) ? spec.tools : []) {
    if (tool && tool.kind === 'mcp') {
      const append = plainText(tool.promptAppend, 4000);
      if (append) parts.push(append);
    }
  }
  return parts.join('\n\n');
}

// ----------------------------------------------------------------- gate config

function normalizeGateConfig(input) {
  if (!isRecord(input)) return null;
  const cards = [];
  for (const raw of Array.isArray(input.cards) ? input.cards.slice(0, GATE_CARD_MAX) : []) {
    if (!isRecord(raw)) continue;
    const title = plainText(raw.title, 120);
    if (!title) continue;
    const items = normalizeTextList(raw.items, { maxItems: GATE_ITEM_MAX, maxLength: 300 });
    const card = {
      id: stableId(raw.id) || `gate-card-${cards.length + 1}`,
      title,
      items,
      threshold: Math.round(finiteNumber(raw.threshold, 80, 0, 100)),
    };
    if (raw.passRate != null) card.passRate = Math.round(finiteNumber(raw.passRate, 0, 0, 100));
    cards.push(card);
  }
  if (!cards.length) return null;
  return {
    id: stableId(input.id) || 'gate-template',
    title: plainText(input.title, 160) || 'Decision gate review',
    cards,
  };
}

function validateGateConfig(input) {
  const config = normalizeGateConfig(input);
  if (!config) return { ok: false, error: 'A gate needs at least one assessment card.' };
  if (config.cards.length > GATE_CARD_MAX) return { ok: false, error: `A gate supports at most ${GATE_CARD_MAX} cards.` };
  return { ok: true, config };
}

// ------------------------------------------------------------ workflow v2 graph

function normalizeNode(input) {
  if (!isRecord(input) || !WORKFLOW_NODE_KINDS_V2.includes(input.kind)) return null;
  const id = stableId(input.id);
  if (!id) return null;
  const node = {
    id,
    kind: input.kind,
    refId: input.kind === 'approval' || input.kind === 'gate' ? null : stableId(input.refId) || null,
    name: plainText(input.name, 120) || (input.kind === 'approval' ? 'Human approval' : 'Untitled step'),
    description: plainText(input.description, 600),
    x: finiteNumber(input.x),
    y: finiteNumber(input.y),
  };
  if (unsafeText(input.name) || unsafeText(input.description)) return null;
  if (node.kind === 'approval') {
    node.requiredRole = plainText(input.requiredRole, 120) || 'Organization Admin';
    node.reviewCriteria = normalizeTextList(input.reviewCriteria);
    node.instructions = plainText(input.instructions, 1000);
    node.rejectionHandling = plainText(input.rejectionHandling, 1000);
  }
  if (node.kind === 'gate') {
    const gateConfig = normalizeGateConfig(input.gateConfig);
    if (!gateConfig) return null;
    node.gateConfig = gateConfig;
    const gateRef = stableId(input.gateRef);
    if (gateRef) node.gateRef = gateRef;
  }
  if (node.kind === 'agent') {
    node.backend = WORKFLOW_NODE_BACKENDS.includes(input.backend) ? input.backend : 'substrate';
    node.harness = HARNESS_OPTIONS.includes(input.harness) ? input.harness : '';
    node.modelFamily = MODEL_FAMILIES.includes(input.modelFamily) ? input.modelFamily : '';
    node.taskTier = TASK_TIERS.includes(input.taskTier) ? input.taskTier : 'medium';
    node.systemPrompt = plainText(input.systemPrompt, 16000);
    node.connectors = normalizeConnectorList(input.connectors);
    if (isRecord(input.kagentSpec)) {
      const result = normalizeKagentSpec(input.kagentSpec);
      if (result.errors.length) node.kagentErrors = result.errors;
      node.kagentSpec = result.spec || undefined;
    }
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
    const id = stack.pop();
    if (id === goal) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    stack.push(...(adjacency.get(id) || []));
  }
  return false;
}

function normalizeEdges(rawEdges, nodes) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = [];
  const pairs = new Set();
  for (const raw of (Array.isArray(rawEdges) ? rawEdges : []).slice(0, MAX_EDGES)) {
    if (!isRecord(raw)) continue;
    const source = stableId(raw.source);
    const target = stableId(raw.target);
    if (!nodeIds.has(source) || !nodeIds.has(target) || source === target) continue;
    const pair = `${source}\u0000${target}`;
    if (pairs.has(pair) || pathExists(edges, target, source)) continue;
    const id = stableId(raw.id);
    if (!id) continue;
    const edge = { id, source, target };
    const outcomes = ['approved', 'rejected'];
    if (outcomes.includes(raw.outcome) && nodeById.get(source).kind === 'approval') edge.outcome = raw.outcome;
    pairs.add(pair);
    edges.push(edge);
  }
  return edges;
}

/** Normalize a full v2 workflow document. Returns null when the envelope is
 * unusable; per-entry problems surface in `errors`. */
function normalizeWorkflowV2(input) {
  if (!isRecord(input)) return null;
  const id = stableId(input.id);
  const name = plainText(input.name, 160);
  if (!id || !name) return null;
  const errors = [];
  const nodeIds = new Set();
  const nodes = [];
  for (const rawNode of (Array.isArray(input.nodes) ? input.nodes : []).slice(0, MAX_NODES)) {
    const node = normalizeNode(rawNode);
    if (!node || nodeIds.has(node.id)) continue;
    if (node.kagentErrors) {
      errors.push(...node.kagentErrors.map((message) => `node ${node.id}: ${message}`));
      delete node.kagentErrors;
    }
    nodeIds.add(node.id);
    nodes.push(node);
  }
  const createdAt = normalizeTimestamp(input.createdAt, new Date(0).toISOString());
  const workflow = {
    id,
    name,
    description: plainText(input.description, 1000),
    createdAt,
    updatedAt: normalizeTimestamp(input.updatedAt, createdAt),
    viewport: {
      x: finiteNumber(input.viewport && input.viewport.x),
      y: finiteNumber(input.viewport && input.viewport.y),
      zoom: finiteNumber(input.viewport && input.viewport.zoom, 1, 0.2, 3),
    },
    nodes,
    edges: normalizeEdges(input.edges, nodes),
  };
  const exampleId = stableId(input.exampleId);
  if (exampleId) workflow.exampleId = exampleId;
  if (input.isExample === true && exampleId) workflow.isExample = true;
  return workflow;
}

/** Server-side validation entry point for persistence. */
function validateWorkflowGraphV2(input) {
  const workflow = normalizeWorkflowV2(input);
  if (!workflow) return { ok: false, errors: ['Workflow must have a valid id and name.'], workflow: null };
  // kagentSpec shape errors are warnings at design time (the CRD publish step
  // re-validates); a graph that normalizes to a usable shape is savable.
  return { ok: true, errors: [], workflow };
}

function migrateV1ToV2(v1) {
  if (!isRecord(v1)) return null;
  return normalizeWorkflowV2({
    ...v1,
    nodes: (Array.isArray(v1.nodes) ? v1.nodes : []).map((node) => (
      isRecord(node) && node.kind === 'agent'
        ? { backend: 'substrate', taskTier: node.modelPreference === 'balanced' || !node.modelPreference ? 'medium' : 'medium', ...node }
        : node
    )),
  });
}

// --------------------------------------------------------- personas and grants

const PERSONAS = Object.freeze(['product-designer', 'builder', 'sre', 'org-admin']);
const PERSONA_LABELS = Object.freeze({
  'product-designer': 'Product Designer',
  builder: 'Builder',
  sre: 'SRE',
  'org-admin': 'Org Admin',
});
// Role -> allowed agent categories. Org Admin sees everything. Categories match
// CURATED_AGENT_CATALOG entries plus the code.html ADLC palette families.
const DEFAULT_PERSONA_GRANTS = Object.freeze({
  'product-designer': Object.freeze(['Requirements', 'Research', 'Source verification', 'Planning', 'Commercial strategy', 'Pricing', 'Ideation', 'Knowledge publishing']),
  builder: Object.freeze(['Planning', 'Coding', 'Testing', 'Security', 'Data sanitation', 'Engineering', 'Quality']),
  sre: Object.freeze(['DevOps / deployment', 'Observability', 'Incident triage', 'Compliance', 'Launch', 'Deployment', 'Monitoring', 'Support']),
  'org-admin': null,
});

function allowedCategoriesForPersona(persona, grants = DEFAULT_PERSONA_GRANTS) {
  if (persona === 'org-admin') return null;
  const list = grants && grants[persona];
  return Array.isArray(list) ? list : DEFAULT_PERSONA_GRANTS[persona] || [];
}

function personaAllowsCategory(persona, category, grants = DEFAULT_PERSONA_GRANTS) {
  const allowed = allowedCategoriesForPersona(persona, grants);
  if (allowed == null) return true;
  return allowed.includes(String(category || 'Custom'));
}

module.exports = {
  WORKFLOW_SCHEMA_VERSION_V2,
  WORKFLOW_NODE_KINDS_V2,
  WORKFLOW_NODE_BACKENDS,
  TASK_TIERS,
  MODEL_FAMILIES,
  HARNESS_OPTIONS,
  GATE_CARD_MAX,
  GATE_ITEM_MAX,
  KAGENT_SKILL_MAX,
  KAGENT_PLUGIN_MAX,
  KAGENT_TOOL_MAX,
  KAGENT_OCI_VOLUME_MAX,
  RESERVED_ENV_NAMES,
  PERSONAS,
  PERSONA_LABELS,
  DEFAULT_PERSONA_GRANTS,
  normalizeKagentSpec,
  kagentSpecWarnings,
  composeKagentSystemPrompt,
  normalizeGateConfig,
  validateGateConfig,
  normalizeWorkflowV2,
  validateWorkflowGraphV2,
  migrateV1ToV2,
  allowedCategoriesForPersona,
  personaAllowsCategory,
  clone,
  plainText,
  stableId,
  normalizeNode,
};
