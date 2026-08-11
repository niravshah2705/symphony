'use strict';

const express = require('express');
const crypto = require('crypto');
const { readStore, writeStore, getApiKey, getAgentConfig } = require('@ai-fleet/shared/store');
const { getProjects, createProject, getOrCreateProjectLabels } = require('@ai-fleet/shared/linear');
const { asyncHandler } = require('@ai-fleet/shared/util');
const { repoParts } = require('@ai-fleet/shared/agent/workspace');
const { normalizeEventContext, matchesEventContext } = require('@ai-fleet/shared/messaging/events');

const router = express.Router();

function workspaceContext(req) {
  return normalizeEventContext(req && req.fleetContext ? req.fleetContext : {});
}

function inWorkspace(req, record) {
  const context = workspaceContext(req);
  return !context.organizationId || matchesEventContext(record, context);
}

function contextFields(req) {
  const context = workspaceContext(req);
  return {
    ...(context.organizationId ? { orgId: context.organizationId } : {}),
    ...(context.projectId ? { nativeProjectId: context.projectId } : {}),
  };
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `biz-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Normalize an operator-supplied repository reference to its canonical namespace.
 * Explicit provider identity is required so a bare namespace cannot change meaning
 * when the global repository connector changes. GitLab may use nested groups.
 */
function normalizeRepo(value, provider = 'github') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parts = repoParts(raw, provider);
  return parts ? parts.fullName : '';
}

function normalizeRepoProvider(value, fallback = 'github') {
  const provider = String(value === undefined ? fallback : value).trim().toLowerCase();
  return provider === 'github' || provider === 'gitlab' ? provider : '';
}

function repositoryFields(body, current = null) {
  const fallbackProvider = current && current.repoProvider ? current.repoProvider : 'github';
  const repoProvider = normalizeRepoProvider(body.repoProvider, fallbackProvider);
  if (!repoProvider) return { error: 'Repository provider must be GitHub or GitLab.' };

  const rawRepo = body.repo !== undefined ? String(body.repo || '').trim() : String((current && current.repo) || '').trim();
  const repo = normalizeRepo(rawRepo, repoProvider);
  if (rawRepo && !repo) {
    const format = repoProvider === 'gitlab' ? 'group/project (nested groups are supported)' : 'owner/repository';
    return { error: `Repository must be a ${repoProvider === 'gitlab' ? 'GitLab' : 'GitHub'} ${format} or matching official-host Git URL.` };
  }
  return { repo, repoProvider };
}

/** Attach the linked Linear project (name/state) to each business, if any. */
async function withProjects(businesses) {
  const linkedIds = businesses.map((b) => b.projectId).filter(Boolean);
  if (linkedIds.length === 0) {
    return businesses.map((b) => ({ ...b, project: null }));
  }
  let projects = [];
  try {
    projects = await getProjects(getApiKey());
  } catch (err) {
    // Without a valid key we still return businesses, just without project detail.
    return businesses.map((b) => ({ ...b, project: null }));
  }
  const byId = new Map(projects.map((p) => [p.id, p]));
  return businesses.map((b) => ({ ...b, project: b.projectId ? byId.get(b.projectId) || null : null }));
}

// GET /api/businesses — businesses with resolved Linear project detail.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const businesses = readStore().businesses.filter((business) => inWorkspace(req, business));
    res.json({ businesses: await withProjects(businesses) });
  })
);

// POST /api/businesses — create a business, optionally creating its Linear project.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const name = (body.name ? String(body.name) : '').trim();
    if (!name) return res.status(400).json({ error: 'Business name is required.' });

    const description = body.description ? String(body.description) : '';
    const repository = repositoryFields(body);
    if (repository.error) return res.status(400).json({ error: repository.error });
    let projectId = body.projectId ? String(body.projectId) : null;

    // Optionally create a brand-new Linear project for this business.
    if (!projectId && body.createNewProject) {
      const teamId = body.teamId ? String(body.teamId) : '';
      if (!teamId) {
        return res.status(400).json({ error: 'A team is required to create a new project.' });
      }
      // Auto-attach the configured enrich labels (default ["AI"]) so the new
      // project is immediately picked up by the enrichment scheduler. Gated by the
      // autoLabelNewProjects config toggle.
      const config = getAgentConfig();
      let labelIds = [];
      if (config.autoLabelNewProjects) {
        const labels = await getOrCreateProjectLabels(getApiKey(), config.enrichLabels);
        labelIds = labels.map((l) => l.id);
      }
      const project = await createProject(getApiKey(), {
        name: body.projectName ? String(body.projectName) : name,
        description,
        teamId,
        labelIds,
      });
      projectId = project.id;
    }

    const store = readStore();
    const business = {
      id: slugify(name),
      name,
      description,
      projectId,
      // Provider is stored beside the canonical namespace so a later global
      // connector switch cannot reinterpret this project repository.
      repo: repository.repo,
      repoProvider: repository.repoProvider,
      ...contextFields(req),
      createdAt: new Date().toISOString(),
    };
    if (store.businesses.some((b) => b.id === business.id && inWorkspace(req, b))) {
      return res.status(409).json({ error: 'A business with that name already exists.' });
    }

    const next = { ...store, businesses: [...store.businesses, business] };
    writeStore(next);
    const [enriched] = await withProjects([business]);
    res.status(201).json({ business: enriched });
  })
);

// PUT /api/businesses/:id — update fields / link a Linear project.
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const store = readStore();
    const index = store.businesses.findIndex((b) => b.id === req.params.id && inWorkspace(req, b));
    if (index === -1) return res.status(404).json({ error: 'Business not found.' });

    const body = req.body || {};
    const current = store.businesses[index];
    const repository = repositoryFields(body, current);
    if (repository.error) return res.status(400).json({ error: repository.error });
    const updated = {
      ...current,
      name: body.name !== undefined ? String(body.name).trim() || current.name : current.name,
      description: body.description !== undefined ? String(body.description) : current.description,
      projectId:
        body.projectId !== undefined
          ? (body.projectId ? String(body.projectId) : null)
          : current.projectId,
      repo: repository.repo,
      repoProvider: repository.repoProvider,
    };

    const businesses = store.businesses.map((b, i) => (i === index ? updated : b));
    writeStore({ ...store, businesses });
    const [enriched] = await withProjects([updated]);
    res.json({ business: enriched });
  })
);

// DELETE /api/businesses/:id — remove the local business mapping (leaves Linear untouched).
router.delete('/:id', (req, res) => {
  const store = readStore();
  const businesses = store.businesses.filter((b) => b.id !== req.params.id || !inWorkspace(req, b));
  if (businesses.length === store.businesses.length) {
    return res.status(404).json({ error: 'Business not found.' });
  }
  writeStore({ ...store, businesses });
  res.json({ ok: true });
});

module.exports = router;
module.exports.normalizeRepo = normalizeRepo;
module.exports.normalizeRepoProvider = normalizeRepoProvider;
module.exports.repositoryFields = repositoryFields;
module.exports.inWorkspace = inWorkspace;
module.exports.contextFields = contextFields;
