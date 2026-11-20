'use strict';

// Server-side persistence API for the workflow designer (schema v2). The
// gateway mounts this behind auth + organization context; per-workspace store
// routing (Firestore root `aifleet_workspace_<hash>`) means every function
// here operates strictly inside the caller's tenant. Platform-global default
// overrides live in the legacy singleton root (readLegacyStore).

const { readStore, writeStore, readLegacyStore, writeLegacyStore } = require('../store.js');
const model = require('./model.js');
const defaults = require('../workflow-defaults.js');

const DEFAULT_PERSONA = defaults.DEFAULT_TENANT_SEED.defaultPersona;

function nowIso() {
  return new Date().toISOString();
}

function byId(list) {
  return new Map(list.map((item) => [item.id, item]));
}

// ------------------------------------------------------------------ workflows

function listWorkflows() {
  return readStore().workflows;
}

function getWorkflow(id) {
  return listWorkflows().find((workflow) => workflow.id === id) || null;
}

/**
 * Create or replace one workflow graph. `expectedRevision` (when given) must
 * match the stored revision — a mismatch returns { conflict: true, workflow }
 * with the server copy so the client can rebase. Returns
 * { ok, workflow } | { conflict, workflow } | { error, errors? }.
 */
function putWorkflow(input, { expectedRevision = null, actor = null } = {}) {
  const validated = model.validateWorkflowGraphV2(input);
  if (!validated.ok) return { error: validated.errors[0] || 'Workflow is invalid.', errors: validated.errors };
  const current = readStore();
  const existing = current.workflows.find((workflow) => workflow.id === validated.workflow.id) || null;
  const storedRevision = existing ? Number(existing.revision) || 0 : 0;
  if (expectedRevision != null && Number(expectedRevision) !== storedRevision) {
    return { conflict: true, workflow: existing };
  }
  const workflow = {
    ...validated.workflow,
    revision: storedRevision + 1,
    updatedAt: nowIso(),
    updatedBy: actor ? String(actor) : null,
  };
  const workflows = existing
    ? current.workflows.map((item) => (item.id === workflow.id ? workflow : item))
    : [...current.workflows, workflow];
  writeStore({ ...current, workflows });
  return { ok: true, workflow };
}

function deleteWorkflow(id) {
  const current = readStore();
  const remaining = current.workflows.filter((workflow) => workflow.id !== id);
  if (remaining.length === current.workflows.length) return { ok: false, error: 'Workflow was not found.' };
  writeStore({ ...current, workflows: remaining });
  return { ok: true };
}

function duplicateWorkflow(id, { name, actor = null } = {}) {
  const source = getWorkflow(id);
  if (!source) return { error: 'Workflow was not found.' };
  const existingIds = new Set(listWorkflows().map((workflow) => workflow.id));
  let copyId = model.stableId(`${id}-copy`) || `${id}-copy`;
  for (let n = 2; existingIds.has(copyId); n += 1) copyId = `${id}-copy-${n}`;
  return putWorkflow({ ...source, id: copyId, name: name || `${source.name} (copy)` }, { expectedRevision: 0, actor });
}

/**
 * First-load seed: copy the platform default WORKFLOWS into a tenant whose
 * collection has never been initialized. Agent profiles are not copied — the
 * merged read (platform defaults + tenant overrides by id) already presents
 * them, and only genuine tenant edits create stored overrides.
 *
 * Graphs seed once per tenant and never again: `workflowGraphsSeededAt` records
 * that the collection has been initialized, so an operator who deletes every
 * graph is not overruled by the next read. Emptiness alone cannot make that
 * call — it is both "never seeded" and "deliberately emptied". Tenants that
 * predate the marker are stamped on the first read that finds graphs, which is
 * what keeps delete-all honest for them too.
 *
 * `seedGraphs: false` defers the copy for the v1-migration read (see
 * `?migrate=1` in the gateway route), where an empty answer must stay empty so
 * the client can see it has somewhere to import into. Grants keep seeding on
 * emptiness: `personaGrants()` merges the stored records over
 * `DEFAULT_PERSONA_GRANTS`, so an empty collection already reads as the
 * defaults and there is no deliberate state for a marker to protect.
 */
function seedTenantFromDefaults({ seedGraphs = true } = {}) {
  const current = readStore();
  const seeded = { workflows: false, agents: false, personaGrants: false };
  let next = current;
  let marked = false;
  if (!next.workflowGraphsSeededAt) {
    const stamp = nowIso();
    if (next.workflows.length) {
      next = { ...next, workflowGraphsSeededAt: stamp };
      marked = true;
    } else if (seedGraphs) {
      next = {
        ...next,
        workflowGraphsSeededAt: stamp,
        workflows: defaults.cloneDefaults().workflows.map((workflow) => ({
          ...workflow, revision: 1, updatedAt: stamp, updatedBy: null,
        })),
      };
      seeded.workflows = true;
      marked = true;
    }
  }
  if (!next.personaGrants.length) {
    next = { ...next, personaGrants: defaults.cloneDefaults().roleGrants };
    seeded.personaGrants = true;
  }
  if (seeded.workflows || seeded.personaGrants || marked) writeStore(next);
  return { seeded, workflows: readStore().workflows.length };
}

/**
 * One-time import of graphs carried over from the localStorage (v1) designer.
 * Refuses while the tenant already has workflows — the client imports only
 * against an empty collection, so a two-tab race can never duplicate.
 */
function importV1Workflows(graphs) {
  const current = readStore();
  if (current.workflows.length) {
    return { ok: false, skipped: true, reason: 'Tenant already has workflows; import skipped.', workflows: current.workflows };
  }
  if (!Array.isArray(graphs) || !graphs.length) return { ok: false, skipped: true, reason: 'No workflows supplied.', workflows: current.workflows };
  const stamp = nowIso();
  const imported = [];
  const seen = new Set();
  for (const raw of graphs.slice(0, 100)) {
    const migrated = model.migrateV1ToV2(raw);
    if (!migrated || seen.has(migrated.id)) continue;
    seen.add(migrated.id);
    imported.push({ ...migrated, revision: 1, updatedAt: stamp, updatedBy: 'v1-import' });
  }
  if (!imported.length) return { ok: false, skipped: true, reason: 'No supplied workflow was valid.', workflows: current.workflows };
  writeStore({ ...current, workflows: imported, workflowGraphsSeededAt: current.workflowGraphsSeededAt || stamp });
  return { ok: true, skipped: false, imported: imported.length, workflows: imported };
}

/** Reset the tenant copy of a component back to the platform default. */
function resetTenantToDefaults({ actor = null } = {}) {
  const current = readStore();
  const fresh = defaults.cloneDefaults();
  const stamp = nowIso();
  writeStore({
    ...current,
    // The reset *is* the initialization this tenant asked for, so the marker
    // moves with it; deleting the restored graphs afterwards must not seed again.
    workflowGraphsSeededAt: current.workflowGraphsSeededAt || stamp,
    workflows: fresh.workflows.map((workflow) => ({ ...workflow, revision: (0 | Number(current.workflows.find((w) => w.id === workflow.id)?.revision)) + 1, updatedAt: stamp, updatedBy: actor ? String(actor) : 'reset' })),
    agents: [],
    personaGrants: fresh.roleGrants,
  });
  return { workflows: readStore().workflows };
}

// -------------------------------------------------------------- agent profiles

/** Tenant profiles merged over the platform defaults (tenant copy wins by id). */
function listAgentProfiles() {
  const merged = byId(defaults.DEFAULT_AGENT_PROFILES.map((profile) => ({ ...profile })));
  for (const profile of readStore().agents) merged.set(profile.id, profile);
  return [...merged.values()];
}

function getAgentProfile(id) {
  return listAgentProfiles().find((profile) => profile.id === id) || null;
}

function upsertAgentProfile(input, { actor = null } = {}) {
  const id = model.stableId(input && input.id);
  const name = model.plainText(input && input.name, 120);
  if (!id || !name) return { error: 'Agent profile needs a valid id and name.' };
  // Normalize whatever backend claims the spec for. The credential-shaped env
  // rows `normalizeKagentSpec` drops only stay out of the document if the
  // normalized result is what gets written — validating and then storing the
  // input left the row in Firestore and in the API response. Shape errors refuse
  // a kagent profile, which has no other runtime to fall back to, and are left to
  // the publish path for any other backend, as they are for graph nodes.
  const normalized = input.kagent == null ? null : model.normalizeKagentSpec(input.kagent);
  if (normalized && input.backend === 'kagent' && normalized.errors.length) {
    return { error: normalized.errors[0], errors: normalized.errors };
  }
  const profile = {
    schemaVersion: 2,
    custom: true,
    id,
    name,
    category: model.plainText(input.category, 120) || 'Custom',
    persona: model.PERSONAS.includes(input.persona) ? input.persona : DEFAULT_PERSONA,
    purpose: model.plainText(input.purpose, 600),
    inputs: Array.isArray(input.inputs) ? input.inputs.map((v) => model.plainText(v, 240)).filter(Boolean).slice(0, 20) : [],
    outputs: Array.isArray(input.outputs) ? input.outputs.map((v) => model.plainText(v, 240)).filter(Boolean).slice(0, 20) : [],
    guardrails: Array.isArray(input.guardrails) ? input.guardrails.map((v) => model.plainText(v, 240)).filter(Boolean).slice(0, 20) : [],
    tools: Array.isArray(input.tools) ? input.tools.map((v) => model.plainText(v, 80)).filter(Boolean).slice(0, 40) : [],
    backend: model.WORKFLOW_NODE_BACKENDS.includes(input.backend) ? input.backend : 'substrate',
    // Same rule as the graph node: the dropdown is populated from the cluster
    // and the global runtime-image registry, so any DNS-shaped name is valid.
    harness: model.HARNESS_OPTIONS.includes(input.harness) ? input.harness
      : (/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(String(input.harness || '')) ? String(input.harness).slice(0, 63) : ''),
    modelFamily: model.MODEL_FAMILIES.includes(input.modelFamily) ? input.modelFamily : '',
    model: model.plainText(input.model, 128),
    taskTier: model.TASK_TIERS.includes(input.taskTier) ? input.taskTier : 'medium',
    connectors: input.connectors || [],
    systemPrompt: model.plainText(input.systemPrompt, 16000),
    kagent: normalized ? normalized.spec : null,
    runtime: model.plainText(input.runtime, 60),
    updatedBy: actor ? String(actor) : null,
    updatedAt: nowIso(),
  };
  const current = readStore();
  const agents = current.agents.some((item) => item.id === id)
    ? current.agents.map((item) => (item.id === id ? profile : item))
    : [...current.agents, profile];
  writeStore({ ...current, agents });
  return { ok: true, profile };
}

function deleteAgentProfile(id) {
  const current = readStore();
  const remaining = current.agents.filter((item) => item.id !== id);
  if (remaining.length === current.agents.length) {
    if (defaults.DEFAULT_AGENT_PROFILES.some((profile) => profile.id === id)) {
      return { ok: false, error: 'Platform default profiles cannot be deleted; edit a tenant copy instead.' };
    }
    return { ok: false, error: 'Agent profile was not found.' };
  }
  const referenced = current.workflows
    .filter((workflow) => (workflow.nodes || []).some((node) => node.kind === 'agent' && node.refId === id))
    .map((workflow) => workflow.id);
  if (referenced.length) return { ok: false, error: `Agent is used by workflow(s): ${referenced.join(', ')}` };
  writeStore({ ...current, agents: remaining });
  return { ok: true };
}

// ---------------------------------------------------------- personas & grants

function personaGrants() {
  const stored = readStore().personaGrants;
  const grants = { ...model.DEFAULT_PERSONA_GRANTS };
  for (const record of stored) {
    if (record && model.PERSONAS.includes(record.persona)) {
      grants[record.persona] = record.allowedCategories == null ? null : [...record.allowedCategories];
    }
  }
  return grants;
}

function getUserPersona(uid) {
  const profiles = readStore().userProfiles || {};
  const record = profiles[String(uid || '')] || null;
  const persona = record && model.PERSONAS.includes(record.persona) ? record.persona : DEFAULT_PERSONA;
  return { persona, displayName: record ? record.displayName : '', hasExplicitPersona: Boolean(record && model.PERSONAS.includes(record.persona)) };
}

function setUserPersona(uid, persona, displayName) {
  if (!model.PERSONAS.includes(persona)) return { error: 'Unknown persona.' };
  const current = readStore();
  const userProfiles = { ...(current.userProfiles || {}) };
  userProfiles[String(uid)] = {
    persona,
    displayName: model.plainText(displayName, 120) || (userProfiles[String(uid)] || {}).displayName || '',
  };
  writeStore({ ...current, userProfiles });
  return { ok: true, persona: userProfiles[String(uid)] };
}

/**
 * Persona gate for one workflow graph: every agent node must reference a
 * profile whose category the persona may use. Returns the list of violations.
 */
function graphPersonaViolations(graph, persona, grants = personaGrants()) {
  const profiles = byId(listAgentProfiles());
  const violations = [];
  for (const node of Array.isArray(graph && graph.nodes) ? graph.nodes : []) {
    if (!node || node.kind !== 'agent') continue;
    const profile = profiles.get(node.refId);
    const category = profile ? profile.category : 'Custom';
    if (!model.personaAllowsCategory(persona, category, grants)) {
      violations.push(`${node.name || node.refId} (category "${category}" is not granted to ${persona})`);
    }
  }
  return violations;
}

// ------------------------------------------------------- platform-global layer

/** Merged platform defaults: code fixtures overridden by the legacy singleton. */
function effectiveWorkflowDefaults() {
  const base = defaults.cloneDefaults();
  const overrides = (readLegacyStore().workflowDefaults) || {};
  if (Array.isArray(overrides.agentProfiles) && overrides.agentProfiles.length) {
    const merged = byId(base.agentProfiles);
    for (const profile of overrides.agentProfiles) if (profile && profile.id) merged.set(profile.id, profile);
    base.agentProfiles = [...merged.values()];
  }
  if (Array.isArray(overrides.workflows) && overrides.workflows.length) {
    const merged = byId(base.workflows);
    for (const workflow of overrides.workflows) if (workflow && workflow.id) merged.set(workflow.id, workflow);
    base.workflows = [...merged.values()];
  }
  if (overrides.gateTemplate && Array.isArray(overrides.gateTemplate.cards) && overrides.gateTemplate.cards.length) {
    base.gateTemplate = overrides.gateTemplate;
  }
  return base;
}

/** Admin-only override of one defaults section, stored in the legacy root. */
function setWorkflowDefaultsSection(section, value) {
  const current = readLegacyStore();
  const workflowDefaults = { ...(current.workflowDefaults || {}) };
  if (section === 'gate') {
    const validation = model.validateGateConfig(value);
    if (!validation.ok) return { error: validation.error };
    workflowDefaults.gateTemplate = { ...validation.config, id: defaults.DEFAULT_GATE_TEMPLATE.id, passRates: undefined };
  } else if (section === 'agents') {
    if (!Array.isArray(value)) return { error: 'agents defaults must be an array.' };
    workflowDefaults.agentProfiles = value;
  } else if (section === 'workflows') {
    if (!Array.isArray(value)) return { error: 'workflows defaults must be an array.' };
    const graphs = value.map((graph) => model.validateWorkflowGraphV2(graph)).filter((r) => r.ok).map((r) => r.workflow);
    if (graphs.length !== value.length) return { error: 'One or more default workflows failed v2 validation.' };
    workflowDefaults.workflows = graphs;
  } else {
    return { error: `Unknown defaults section "${section}".` };
  }
  writeLegacyStore({ ...current, workflowDefaults });
  return { ok: true, section };
}

module.exports = {
  DEFAULT_PERSONA,
  listWorkflows,
  getWorkflow,
  putWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  seedTenantFromDefaults,
  importV1Workflows,
  resetTenantToDefaults,
  listAgentProfiles,
  getAgentProfile,
  upsertAgentProfile,
  deleteAgentProfile,
  personaGrants,
  getUserPersona,
  setUserPersona,
  graphPersonaViolations,
  effectiveWorkflowDefaults,
  setWorkflowDefaultsSection,
};
