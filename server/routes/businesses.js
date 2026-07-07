'use strict';

const express = require('express');
const crypto = require('crypto');
const { readStore, writeStore, getApiKey, getAgentConfig } = require('../store');
const { getProjects, createProject, getOrCreateProjectLabels } = require('../linear');
const { asyncHandler } = require('../util');

const router = express.Router();

function slugify(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `biz-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Normalize an operator-supplied repository reference to a canonical `owner/name`,
 * accepting a bare `owner/name`, an https GitHub URL, or an ssh GitHub URL. Returns
 * '' when absent/invalid. Restricting to a GitHub owner/name (allowlist chars) keeps
 * a project's repo config from becoming an arbitrary-host clone target (SSRF/injection).
 */
function normalizeRepo(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const SEG = '[A-Za-z0-9_.-]+';
  let m = raw.match(new RegExp(`^(${SEG})/(${SEG}?)(?:\\.git)?$`));
  if (!m) m = raw.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!m) return '';
  return `${m[1]}/${m[2]}`;
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
    const businesses = readStore().businesses;
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
      // Repository (owner/name) for future code generation — the coding flow clones
      // this per project. Validated + normalized; '' when not provided.
      repo: normalizeRepo(body.repo),
      createdAt: new Date().toISOString(),
    };
    if (store.businesses.some((b) => b.id === business.id)) {
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
    const index = store.businesses.findIndex((b) => b.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Business not found.' });

    const body = req.body || {};
    const current = store.businesses[index];
    const updated = {
      ...current,
      name: body.name !== undefined ? String(body.name).trim() || current.name : current.name,
      description: body.description !== undefined ? String(body.description) : current.description,
      projectId:
        body.projectId !== undefined
          ? (body.projectId ? String(body.projectId) : null)
          : current.projectId,
      repo: body.repo !== undefined ? normalizeRepo(body.repo) : (current.repo || ''),
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
  const businesses = store.businesses.filter((b) => b.id !== req.params.id);
  if (businesses.length === store.businesses.length) {
    return res.status(404).json({ error: 'Business not found.' });
  }
  writeStore({ ...store, businesses });
  res.json({ ok: true });
});

module.exports = router;
