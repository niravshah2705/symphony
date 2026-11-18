'use strict';

/**
 * Workflow designer persistence API (schema v2 — agent substrate + kagent).
 *
 * Mounted (in index.js) behind requireAuthenticated + requirePermission
 * ('workspace') + requireOrganizationContext, so every handler runs inside the
 * caller's per-workspace store scope; cross-org ids simply do not exist (404),
 * never 403. Persona gating is enforced HERE, server-side: the browser's
 * persona filter is a convenience, this is the boundary. The persona comes from
 * the verified Firebase uid → tenant userProfiles record, default 'builder'.
 */

const express = require('express');
const { asyncHandler } = require('@ai-fleet/shared-core/util');
const wfStore = require('@ai-fleet/shared-core/workflow/store');
const { PERSONAS, personaAllowsCategory } = require('@ai-fleet/shared-core/workflow/model');
const { cleanContextId } = require('../request-context');

function callerUid(req) {
  const user = req.auth && req.auth.user;
  if (user && user.sub) return String(user.sub);
  if (user && user.email) return String(user.email);
  return 'local-operator';
}

function isGlobalAdmin(req) {
  return Boolean(req.auth && req.auth.role === 'admin');
}

function callerContext(req) {
  const uid = callerUid(req);
  const personaRecord = wfStore.getUserPersona(uid);
  return {
    uid,
    actor: (req.auth && req.auth.user && (req.auth.user.email || req.auth.user.name)) || uid,
    persona: personaRecord.persona,
    displayName: personaRecord.displayName,
    grants: wfStore.personaGrants(),
    isAdmin: isGlobalAdmin(req),
  };
}

function denyPersona(res, violations) {
  return res.status(403).json({
    error: 'Your persona is not granted one or more agents in this workflow.',
    code: 'persona_denied',
    violations,
  });
}

function assertGraphPersona(res, ctx, graph) {
  if (ctx.isAdmin) return true;
  const violations = wfStore.graphPersonaViolations(graph, ctx.persona, ctx.grants);
  return violations.length ? (denyPersona(res, violations), false) : true;
}

function workflowId(req) {
  return cleanContextId(String(req.params.id || ''));
}

function expectedRevision(req) {
  const header = req.get('if-match');
  const raw = header != null && header !== '' ? header : (req.body && req.body.revision);
  if (raw == null || raw === '') return null;
  const value = Number(String(raw).replace(/"/g, ''));
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function createWorkflowsRouter({ kagentAdapter = null, substrateAdapter = null } = {}) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    // `?migrate=1` asks for the tenant's real emptiness instead of a seeded
    // copy: the designer sends it only when it holds localStorage graphs it
    // has not imported yet, and lazy seeding would answer that read with
    // platform examples, so the import would never find an empty collection.
    const migrate = String(req.query.migrate || '') === '1';
    wfStore.seedTenantFromDefaults({ seedGraphs: !migrate });
    const ctx = callerContext(req);
    res.set('Cache-Control', 'no-store').json({
      workflows: wfStore.listWorkflows(),
      agents: wfStore.listAgentProfiles(),
      persona: ctx.persona,
      displayName: ctx.displayName,
      grants: ctx.grants,
      personas: [...PERSONAS],
      gateTemplate: wfStore.effectiveWorkflowDefaults().gateTemplate,
      canAdminDefaults: ctx.isAdmin,
    });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const ctx = callerContext(req);
    const graph = { ...bodyOf(req), id: cleanContextId(String(bodyOf(req).id || '')) };
    if (!graph.id) return res.status(400).json({ error: 'Workflow id is required.' });
    const exists = wfStore.getWorkflow(graph.id);
    if (exists) return res.status(409).json({ error: 'Workflow id already exists.', code: 'already_exists', workflow: exists });
    if (!assertGraphPersona(res, ctx, graph)) return undefined;
    const result = wfStore.putWorkflow(graph, { expectedRevision: 0, actor: ctx.actor });
    if (result.error) return res.status(400).json({ error: result.error, errors: result.errors });
    return res.status(201).json(result.workflow);
  }));

  router.put('/:id', asyncHandler(async (req, res) => {
    const ctx = callerContext(req);
    const id = workflowId(req);
    const graph = { ...bodyOf(req), id };
    if (!assertGraphPersona(res, ctx, graph)) return undefined;
    const result = wfStore.putWorkflow(graph, { expectedRevision: expectedRevision(req), actor: ctx.actor });
    if (result.conflict) {
      return res.status(409).json({ error: 'revision_conflict', code: 'revision_conflict', workflow: result.workflow });
    }
    if (result.error) return res.status(400).json({ error: result.error, errors: result.errors });
    return res.json(result.workflow);
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const id = workflowId(req);
    const result = wfStore.deleteWorkflow(id);
    if (!result.ok) return res.status(404).json({ error: result.error });
    return res.json({ ok: true, id });
  }));

  router.post('/:id/duplicate', asyncHandler(async (req, res) => {
    const ctx = callerContext(req);
    const source = wfStore.getWorkflow(workflowId(req));
    if (!source) return res.status(404).json({ error: 'Workflow was not found.' });
    if (!assertGraphPersona(res, ctx, source)) return undefined;
    const result = wfStore.duplicateWorkflow(source.id, { name: bodyOf(req).name, actor: ctx.actor });
    if (result.error) return res.status(400).json({ error: result.error });
    return res.status(201).json(result.workflow);
  }));

  router.post('/reset', asyncHandler(async (req, res) => {
    const ctx = callerContext(req);
    const { workflows } = wfStore.resetTenantToDefaults({ actor: ctx.actor });
    return res.json({ ok: true, workflows });
  }));

  // One-time carry-over of graphs designed in the localStorage (v1) designer.
  router.post('/import', asyncHandler(async (req, res) => {
    const ctx = callerContext(req);
    const supplied = bodyOf(req).workflows;
    // Every other graph write passes this gate, and the v1 payload is a graph
    // write: `importV1Workflows` only defaults `backend`/`taskTier`, so the agent
    // nodes arrive with their `kind` and `refId` intact and are checked as stored.
    // Without it, a persona that `PUT /:id` refuses could still land the same
    // graph here — the browser sends an import with `canWrite` from the org role,
    // which is a different record from the persona this gate reads.
    if (Array.isArray(supplied)) {
      for (const graph of supplied) if (!assertGraphPersona(res, ctx, graph)) return undefined;
    }
    const result = wfStore.importV1Workflows(supplied);
    if (!result.ok && !result.skipped) return res.status(400).json({ error: result.reason });
    if (result.skipped && !result.workflows.length) return res.status(400).json({ error: result.reason });
    return res.json({ imported: result.imported || 0, skipped: Boolean(result.skipped), workflows: wfStore.listWorkflows() });
  }));

  // ------------------------------------------------------------ agent profiles

  router.get('/agents', asyncHandler(async (req, res) => {
    res.json({ agents: wfStore.listAgentProfiles() });
  }));

  router.post('/agents', asyncHandler(async (req, res) => {
    const ctx = callerContext(req);
    const result = wfStore.upsertAgentProfile(bodyOf(req), { actor: ctx.actor });
    if (result.error) return res.status(400).json({ error: result.error, errors: result.errors });
    return res.status(201).json(result.profile);
  }));

  router.put('/agents/:id', asyncHandler(async (req, res) => {
    const ctx = callerContext(req);
    const input = { ...bodyOf(req), id: workflowId(req) };
    const result = wfStore.upsertAgentProfile(input, { actor: ctx.actor });
    if (result.error) return res.status(400).json({ error: result.error, errors: result.errors });
    return res.json(result.profile);
  }));

  router.delete('/agents/:id', asyncHandler(async (req, res) => {
    const result = wfStore.deleteAgentProfile(workflowId(req));
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json({ ok: true, id: workflowId(req) });
  }));

  router.get('/gate-template', asyncHandler(async (req, res) => {
    res.json(wfStore.effectiveWorkflowDefaults().gateTemplate);
  }));

  // --------------------------------------------------------- persona & me

  router.get('/me', asyncHandler(async (req, res) => {
    const ctx = callerContext(req);
    res.json({ persona: ctx.persona, displayName: ctx.displayName, grants: ctx.grants, personas: [...PERSONAS] });
  }));

  router.put('/me/persona', asyncHandler(async (req, res) => {
    const ctx = callerContext(req);
    const persona = String(bodyOf(req).persona || '');
    if (!PERSONAS.includes(persona)) return res.status(400).json({ error: 'persona must be one of ' + PERSONAS.join(', ') });
    const result = wfStore.setUserPersona(ctx.uid, persona, bodyOf(req).displayName);
    if (result.error) return res.status(400).json({ error: result.error });
    return res.json({ persona: result.persona, grants: wfStore.personaGrants() });
  }));

  // ------------------------------------------------- kagent / substrate surface

  router.get('/kagent/capabilities', asyncHandler(async (req, res) => {
    if (!kagentAdapter || !kagentAdapter.enabled || !kagentAdapter.enabled()) {
      return res.json({ enabled: false, reason: 'kagent_not_configured', harnesses: [], modelConfigs: [], remoteMcpServers: [], agentTemplates: [] });
    }
    try {
      return res.json({ enabled: true, ...(await kagentAdapter.capabilities()) });
    } catch (error) {
      return res.status(502).json({ error: 'kagent_capabilities_failed', detail: String(error.message || error).slice(0, 300) });
    }
  }));

  router.post('/agents/:id/publish', asyncHandler(async (req, res) => {
    const ctx = callerContext(req);
    const profile = wfStore.getAgentProfile(workflowId(req));
    if (!profile) return res.status(404).json({ error: 'Agent profile was not found.' });
    if (!ctx.isAdmin) {
      if (!personaAllowsCategory(ctx.persona, profile.category, ctx.grants)) {
        return denyPersona(res, [`${profile.name} (category "${profile.category}")`]);
      }
    }
    if (profile.backend === 'kagent') {
      if (!kagentAdapter || !kagentAdapter.enabled || !kagentAdapter.enabled()) {
        return res.status(503).json({ error: 'kagent_not_configured' });
      }
      const outcome = await kagentAdapter.publishProfile(profile);
      return res.status(outcome.ok ? 200 : 502).json(outcome);
    }
    if (!substrateAdapter || !substrateAdapter.publishProfile) {
      return res.status(503).json({ error: 'substrate_not_configured' });
    }
    const outcome = await substrateAdapter.publishProfile(profile);
    return res.status(outcome.ok ? 200 : 502).json(outcome);
  }));

  // Publish one agent NODE of a saved graph. This is a node route because the
  // node is where the runtime binding lives: `renderAgentCrd` reads
  // `systemPrompt` / `kagentSpec` / `harness` off the same object the canvas
  // saved, so publishing the profile instead would render a CR for a binding
  // nobody edited. Substrate is the exception and it is deliberate: a substrate
  // run executes the curated profile as an actor, so the node contributes only
  // its location in the graph and the profile is what gets published.
  router.post('/:id/nodes/:nodeId/publish', asyncHandler(async (req, res) => {
    const ctx = callerContext(req);
    const graph = wfStore.getWorkflow(cleanContextId(String(req.params.id || '')));
    if (!graph) return res.status(404).json({ error: 'Workflow was not found.' });
    const nodeId = cleanContextId(String(req.params.nodeId || ''));
    const node = (graph.nodes || []).find((candidate) => candidate.id === nodeId);
    if (!node) return res.status(404).json({ error: 'Agent node was not found in this workflow.' });
    if (node.kind !== 'agent') {
      return res.status(400).json({ error: 'Only an agent node can be published to a runtime.' });
    }
    if (!ctx.isAdmin) {
      // The same grant check as a graph save, applied to this node alone: an
      // agent node the persona may not run cannot be published by it either.
      const violations = wfStore.graphPersonaViolations(
        { ...graph, nodes: [node], edges: [] },
        ctx.persona,
        ctx.grants,
      );
      if (violations.length) return denyPersona(res, violations);
    }
    if (node.backend === 'kagent') {
      if (!kagentAdapter || !kagentAdapter.enabled || !kagentAdapter.enabled()) {
        return res.status(503).json({ error: 'kagent_not_configured' });
      }
      // The CR is named after where the binding lives, not after the bare node
      // id: `n1` is unique inside a graph and identical across every graph, so
      // two workflows would overwrite one another's Agent.
      const outcome = await kagentAdapter.publishProfile({ ...node, crdName: `${graph.id}-${node.id}` });
      return res.status(outcome.ok ? 200 : 502).json({ ...outcome, workflowId: graph.id, nodeId: node.id, backend: 'kagent' });
    }
    const profile = wfStore.getAgentProfile(node.refId);
    if (!profile) return res.status(404).json({ error: 'The agent profile behind this node was not found.' });
    if (!substrateAdapter || !substrateAdapter.publishProfile) {
      return res.status(503).json({ error: 'substrate_not_configured' });
    }
    const outcome = await substrateAdapter.publishProfile(profile);
    return res.status(outcome.ok ? 200 : 502).json({ ...outcome, workflowId: graph.id, nodeId: node.id, backend: 'substrate' });
  }));

  // ---------------------------------------------- platform-global defaults API

  router.get('/defaults', asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(wfStore.effectiveWorkflowDefaults());
  }));

  router.put('/defaults/:section', asyncHandler(async (req, res) => {
    if (!isGlobalAdmin(req)) return res.status(403).json({ error: 'Platform defaults require the global admin role.', code: 'access_denied' });
    const section = cleanContextId(String(req.params.section || ''));
    const result = wfStore.setWorkflowDefaultsSection(section, req.body && req.body.value);
    if (result.error) return res.status(400).json({ error: result.error });
    return res.json({ ok: true, section, defaults: wfStore.effectiveWorkflowDefaults() });
  }));

  return router;
}

module.exports = { createWorkflowsRouter, callerUid, expectedRevision };
