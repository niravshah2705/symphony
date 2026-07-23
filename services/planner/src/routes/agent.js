'use strict';

const express = require('express');
const {
  getApiKey,
  getSettings,
  getAssumedRole,
  getAgentConfig,
  setAgentConfig,
  listJobs,
  removeJob,
  clearFinishedJobs,
  readStore,
  listMemories,
  addMemory,
  removeMemory,
} = require('@ai-fleet/shared/store');
const { getProjectsWithLabels, getAllProjectLabels } = require('@ai-fleet/shared/linear');
const { asyncHandler } = require('@ai-fleet/shared/util');
const { CONFIG } = require('@ai-fleet/shared/config');
const scheduler = require('@ai-fleet/shared/agent/scheduler');
const { llmReady, providerForRole } = require('@ai-fleet/shared/agent/llm');
const localIntelligence = require('@ai-fleet/shared/agent/local-intelligence');
const { applySettingsPatch, sanitizeSettingsPatch } = require('@ai-fleet/shared/agent/settings-patch');
const workspaceRouter = require('@ai-fleet/shared/agent/workspace-router');
const { searchDocuments } = require('@ai-fleet/shared/agent/knowledge-search');
const memory = require('@ai-fleet/shared/agent/memory');
const businessPipeline = require('@ai-fleet/shared/agent/business-pipeline');

const REF_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const router = express.Router();

/**
 * Enforce that a role is assumed before any enrichment action. This is the
 * server-side gate behind the UI's disabled state — UI gating alone is not
 * authorization (client-side-enforcement / authentication-failures checklists).
 */
function requireAssumedRole(req, res, next) {
  const role = getAssumedRole();
  if (!role) {
    return res.status(403).json({ error: 'Assume a role before enriching projects.' });
  }
  req.assumedRole = role;
  next();
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Configured model name for the active provider (for status display). */
function activeModelFor(provider, settings) {
  if (provider === 'claude') return settings.claudeModel || CONFIG.CLAUDE.defaultModel;
  if (provider === 'codex') {
    const fallback = CONFIG.OAUTH.backend === 'chatgpt' ? CONFIG.OAUTH.chatgptModel : CONFIG.OAUTH.defaultModel;
    return settings.codexModel || fallback;
  }
  if (provider === 'lmstudio') return settings.lmstudioModel;
  if (provider === 'omlx') return settings.omlxModel;
  return settings.ollamaModel;
}

function sanitizeLabels(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const cleaned = [...new Set(value.map((l) => String(l || '').trim()).filter(Boolean))];
  return cleaned;
}

/** Whitelist + clamp the config patch — never persist arbitrary fields. */
function sanitizeConfig(body, current) {
  const b = body || {};
  const intervalMinutes = CONFIG.INTERVAL_OPTIONS.includes(Number(b.intervalMinutes))
    ? Number(b.intervalMinutes)
    : current.intervalMinutes;
  return {
    parallelProcessing: clampInt(b.parallelProcessing, 1, 8, current.parallelProcessing),
    maxConcurrentCoders: clampInt(b.maxConcurrentCoders, 1, 8, current.maxConcurrentCoders),
    maxProjectsPerRun: clampInt(b.maxProjectsPerRun, 1, 20, current.maxProjectsPerRun),
    maxMilestones: clampInt(b.maxMilestones, 1, 12, current.maxMilestones),
    maxIssuesPerMilestone: clampInt(b.maxIssuesPerMilestone, 0, 12, current.maxIssuesPerMilestone),
    intervalMinutes,
    enrichLabels: b.enrichLabels !== undefined ? sanitizeLabels(b.enrichLabels, current.enrichLabels) : current.enrichLabels,
    scheduleEnabled: typeof b.scheduleEnabled === 'boolean' ? b.scheduleEnabled : current.scheduleEnabled,
    autoAssignLead: typeof b.autoAssignLead === 'boolean' ? b.autoAssignLead : current.autoAssignLead,
    autoLabelNewProjects:
      typeof b.autoLabelNewProjects === 'boolean' ? b.autoLabelNewProjects : current.autoLabelNewProjects,
    createIssues: typeof b.createIssues === 'boolean' ? b.createIssues : current.createIssues,
    addDependencies: typeof b.addDependencies === 'boolean' ? b.addDependencies : current.addDependencies,
  };
}

// GET /api/agent/config
router.get('/config', (req, res) => {
  res.json({ config: getAgentConfig() });
});

// GET /api/agent/models — scheduler interval choices (local).
router.get('/models', (req, res) => {
  res.json({ intervals: CONFIG.INTERVAL_OPTIONS });
});

// GET /api/agent/ollama-models — models installed on the configured Ollama host.
// Best-effort: returns an empty list if Ollama is unreachable.
router.get(
  '/ollama-models',
  asyncHandler(async (req, res) => {
    const host = getSettings().ollamaHost;
    try {
      const resp = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(4000) });
      if (!resp.ok) return res.json({ models: [], reachable: false });
      const data = await resp.json();
      const models = (data.models || []).map((m) => m.name).filter(Boolean).sort();
      res.json({ models, reachable: true });
    } catch (_) {
      res.json({ models: [], reachable: false });
    }
  })
);

// GET /api/agent/lmstudio-models — models available on the configured LM Studio
// host. LM Studio exposes an OpenAI-compatible list at `/v1/models`. Best-effort:
// returns an empty list if LM Studio is unreachable.
router.get(
  '/lmstudio-models',
  asyncHandler(async (req, res) => {
    const host = getSettings().lmstudioHost;
    try {
      const resp = await fetch(`${host}/v1/models`, { signal: AbortSignal.timeout(4000) });
      if (!resp.ok) return res.json({ models: [], reachable: false });
      const data = await resp.json();
      const models = (data.data || []).map((m) => m.id).filter(Boolean).sort();
      res.json({ models, reachable: true });
    } catch (_) {
      res.json({ models: [], reachable: false });
    }
  })
);

// GET /api/agent/omlx-models — models advertised by the configured oMLX server.
// oMLX auto-loads/evicts models, so discovery represents availability rather
// than the model's current in-memory state. Optional API-key auth stays server-side.
router.get(
  '/omlx-models',
  asyncHandler(async (req, res) => {
    const settings = getSettings();
    const host = String(settings.omlxHost || CONFIG.OMLX.defaultHost)
      .replace(/\/v1\/?$/i, '')
      .replace(/\/$/, '');
    const headers = { Accept: 'application/json' };
    if (settings.omlxApiKey) headers.Authorization = `Bearer ${settings.omlxApiKey}`;
    try {
      const resp = await fetch(`${host}${CONFIG.OMLX.apiPath}/models`, {
        headers,
        signal: AbortSignal.timeout(4000),
      });
      if (!resp.ok) return res.json({ models: [], reachable: false });
      const data = await resp.json();
      const models = (data.data || [])
        .map((model) => {
          const id = String(model && model.id || '').trim();
          if (!id) return null;
          const contextWindow = Number(model.max_model_len);
          return {
            id,
            label: id,
            ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.id.localeCompare(b.id));
      res.json({ models, reachable: true, source: 'local' });
    } catch (_) {
      res.json({ models: [], reachable: false });
    }
  })
);

// GET /api/agent/labels — distinct Linear project labels (for the dropdown).
router.get(
  '/labels',
  asyncHandler(async (req, res) => {
    const labels = await getAllProjectLabels(getApiKey());
    res.json({ labels });
  })
);

// PUT /api/agent/config
router.put('/config', (req, res) => {
  const next = sanitizeConfig(req.body, getAgentConfig());
  setAgentConfig(next);
  res.json({ config: next });
});

// GET /api/agent/status — scheduler + readiness for the dashboard.
router.get('/status', (req, res) => {
  const settings = getSettings();
  const config = getAgentConfig();
  const codexTokens = settings.codexTokens;
  // The planner runs on the `thinking` role, so the dashboard LLM pill reflects
  // that role's provider/model and readiness.
  const provider = providerForRole(settings, 'thinking');
  const localProvider = settings.localLlmProvider || settings.llmProvider || 'ollama';
  res.json({
    ...scheduler.getStatus(),
    assumedRole: getAssumedRole(),
    llmConfigured: llmReady(settings, 'thinking'),
    llmProvider: provider,
    // Model for the active provider — used for the dashboard's LLM pill.
    activeModel: activeModelFor(provider, settings),
    localLlmProvider: localProvider,
    localActiveModel: activeModelFor(localProvider, settings),
    ollamaModel: settings.ollamaModel,
    lmstudioModel: settings.lmstudioModel,
    omlxModel: settings.omlxModel,
    codexModel: settings.codexModel || CONFIG.OAUTH.defaultModel,
    codexConnected: Boolean(codexTokens && (codexTokens.accessToken || codexTokens.refreshToken)),
    tracingEnabled: Boolean(settings.langsmithApiKey && settings.langsmithTracing),
    langsmithProject: settings.langsmithProject,
    enrichLabels: config.enrichLabels,
    intervalMinutes: config.intervalMinutes,
  });
});

// GET /api/agent/candidates — open projects the auto-enrichment will pick up
// (no lead + configured label). Read-only preview. Role required.
router.get(
  '/candidates',
  requireAssumedRole,
  asyncHandler(async (req, res) => {
    const labels = getAgentConfig().enrichLabels;
    const projects = await getProjectsWithLabels(getApiKey(), labels);
    res.json({ labels, projects: projects.map((p) => ({ id: p.id, name: p.name, progress: p.progress })) });
  })
);

// GET /api/agent/jobs — enrichment job history.
router.get('/jobs', (req, res) => {
  res.json({ jobs: listJobs() });
});

// POST /api/agent/message — deterministic intent and safety gate for the Agent
// omnibox. Greetings and rejected abuse never reach retrieval, a model, tools,
// or a mutation. Business/general requests may use the configured local model
// only to enrich their bounded, already-routed context.
router.post(
  '/message',
  asyncHandler(async (req, res) => {
    const route = workspaceRouter.classifyIntent(req.body && req.body.input);
    let enrichment = null;
    let warning = null;
    let memoryDraft = null;
    let canPrepare = false;

    if (route.intent === 'business') {
      // Keep /message fast: the real 6-step pipeline (fraud, revenue, memory,
      // spec breakdown, UI design, scheduling) runs on demand via /business/prepare.
      canPrepare = true;
    } else if (route.intent === 'general') {
      try {
        enrichment = await localIntelligence.enrichInput({
          input: route.input,
          scenario: 'planning',
          metadata: { intent: route.intent, workflow: 'thinker' },
          settings: getSettings(),
        });
      } catch (error) {
        warning = error && error.message
          ? error.message
          : 'The configured local model was unavailable; the deterministic route is still ready.';
      }
    } else if (route.intent === 'knowledge') {
      // "Remember this" phrasing yields a confirmable draft only — the write is a
      // separate, explicit POST /memory. Free text never auto-persists.
      memoryDraft = memory.detectMemoryWrite(route.input);
    }

    res.json({ route, enrichment, warning, memoryDraft, canPrepare });
  })
);

// POST /api/agent/knowledge-search — bounded, read-only lexical retrieval over
// the workspace's README/docs corpus. It returns real relative paths and
// snippets, never arbitrary files, absolute paths, credentials, or model prose.
router.post('/knowledge-search', (req, res) => {
  res.json(searchDocuments(req.body && (req.body.query || req.body.input)));
});

// POST /api/agent/memory-search — typed, read-only recall across the five memory
// scopes, blended with reviewed documentation. Scope is detected from the query
// when not explicitly supplied. Never returns secrets or absolute paths.
router.post('/memory-search', (req, res) => {
  const body = req.body || {};
  const query = typeof body.query === 'string' ? body.query : typeof body.input === 'string' ? body.input : '';
  const requested = typeof body.scope === 'string' ? body.scope.toLowerCase() : '';
  const scope = memory.MEMORY_SCOPES.includes(requested) ? requested : memory.detectMemoryScope(query);
  const results = memory.searchMemories(query, listMemories(), { scope });
  // Blend reviewed docs for the workspace scope (or when the scope is ambiguous).
  if ((scope === 'workspace' || scope === 'all') && query.trim()) {
    try {
      const docs = searchDocuments(query);
      for (const doc of docs.results || []) {
        results.push({ scope: 'workspace', type: 'Workspace document', title: doc.title, summary: doc.snippet, status: doc.path, refId: null });
      }
    } catch (_) {
      // A bad/empty query for the doc index is non-fatal; stored memory still returns.
    }
  }
  res.json({ query, scope, results: results.slice(0, 12) });
});

// POST /api/agent/memory — persist a confirmed memory (the write). Validation
// (scope allowlist, bounded fields, safe refId) happens in normalizeMemory;
// a MemoryError carries a 400 to the central error handler.
router.post('/memory', (req, res) => {
  const record = addMemory(memory.normalizeMemory(req.body));
  res.status(201).json({ memory: record });
});

// GET /api/agent/memory — list stored memories, optionally filtered by scope/refId.
router.get('/memory', (req, res) => {
  const requested = typeof req.query.scope === 'string' ? req.query.scope.toLowerCase() : '';
  const scope = memory.MEMORY_SCOPES.includes(requested) ? requested : undefined;
  const refId = typeof req.query.refId === 'string' && REF_ID_PATTERN.test(req.query.refId) ? req.query.refId : undefined;
  res.json({ memories: listMemories({ scope, refId }) });
});

// DELETE /api/agent/memory/:id — remove one stored memory.
router.delete('/memory/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!/^mem_[A-Za-z0-9-]{1,80}$/.test(id)) return res.status(400).json({ error: 'Invalid memory id.' });
  if (!removeMemory(id)) return res.status(404).json({ error: 'Memory not found.' });
  res.json({ ok: true });
});

// POST /api/agent/business/prepare — run the real, on-demand business pipeline.
// The unsafe gate is re-asserted inside prepareBusiness; a missing role/project
// degrades the scheduling stage rather than failing the whole request.
router.post(
  '/business/prepare',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    let business = null;
    if (typeof body.businessId === 'string' && REF_ID_PATTERN.test(body.businessId)) {
      business = readStore().businesses.find((b) => b.id === body.businessId) || null;
    }
    const payload = await businessPipeline.prepareBusiness({
      input: typeof body.input === 'string' ? body.input : '',
      business,
      settings: getSettings(),
      assumedRole: getAssumedRole(),
    });
    res.json({ business: payload });
  })
);

// POST /api/agent/enrich-input — turn short user notes into a clearer brief via
// the configured LOCAL role only (Ollama / LM Studio / oMLX; never a hosted fallback).
router.post(
  '/enrich-input',
  asyncHandler(async (req, res) => {
    const input = localIntelligence.normalizeEnrichmentRequest(req.body);
    const enrichment = await localIntelligence.enrichInput({ ...input, settings: getSettings() });
    res.json({ enrichment });
  })
);

function traceFromJob(job) {
  const coding = job.kind === 'coding';
  const title = coding
    ? `${job.taskIdentifier || 'Coding task'}${job.taskTitle ? ` · ${job.taskTitle}` : ''}`
    : job.projectName || 'Enrichment job';
  return {
    id: job.id,
    title,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    summary: job.summary || job.error || null,
    steps: job.steps || [],
  };
}

function traceForAnalysis(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new localIntelligence.LocalIntelligenceError('A JSON request body is required.');
  }
  const hasJobId = Object.prototype.hasOwnProperty.call(body, 'jobId');
  const hasTrace = Object.prototype.hasOwnProperty.call(body, 'trace');
  if (hasJobId === hasTrace) {
    throw new localIntelligence.LocalIntelligenceError('Provide exactly one of jobId or trace.');
  }
  if (hasTrace) return localIntelligence.normalizeTraceRequest(body);

  if (typeof body.jobId !== 'string') {
    throw new localIntelligence.LocalIntelligenceError('jobId must be a string.');
  }
  const jobId = body.jobId.trim();
  if (!jobId || jobId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new localIntelligence.LocalIntelligenceError('jobId is not valid.');
  }
  const job = listJobs().find((candidate) => candidate.id === jobId);
  if (!job) throw new localIntelligence.LocalIntelligenceError('Job not found.', 404);
  return localIntelligence.normalizeTrace(traceFromJob(job));
}

// POST /api/agent/analyze-trace — analyze an existing job by id, or a bounded
// caller-supplied trace. The model sees fenced, untrusted data and has no tools.
router.post(
  '/analyze-trace',
  asyncHandler(async (req, res) => {
    const trace = traceForAnalysis(req.body);
    const analysis = await localIntelligence.analyzeTrace({ trace, settings: getSettings() });
    res.json({ analysis });
  })
);

// POST /api/agent/settings-command — interpret a natural-language settings
// request with the LOCAL model only, then apply the validated (non-secret) patch
// to the store (data/store.json). Pass { apply: false } to preview without saving.
router.post(
  '/settings-command',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const instruction =
      typeof body.instruction === 'string'
        ? body.instruction
        : typeof body.input === 'string'
          ? body.input
          : '';
    const proposal = await localIntelligence.proposeSettings({ instruction, settings: getSettings() });
    const preview = body.apply === false;
    const outcome = preview ? sanitizeSettingsPatch(proposal.patch) : applySettingsPatch(proposal.patch);
    res.json({
      command: {
        instruction: proposal.instruction,
        notes: proposal.notes,
        patch: proposal.patch,
        provenance: proposal.provenance,
        warnings: proposal.warnings,
      },
      applied: preview ? [] : outcome.applied,
      preview: preview ? outcome.patch : undefined,
      rejected: outcome.rejected,
      ignored: outcome.ignored,
    });
  })
);

// DELETE /api/agent/jobs — clear all finished (done/error) jobs.
router.delete('/jobs', (req, res) => {
  const jobs = clearFinishedJobs();
  res.json({ jobs });
});

// DELETE /api/agent/jobs/:id — remove a single job.
router.delete('/jobs/:id', (req, res) => {
  const removed = removeJob(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Job not found.' });
  res.json({ ok: true });
});

// POST /api/agent/run-now — manual scheduler tick (still bounded/non-overlapping).
router.post(
  '/run-now',
  requireAssumedRole,
  asyncHandler(async (req, res) => {
    const result = await scheduler.processPending();
    res.json({ result, status: scheduler.getStatus() });
  })
);

module.exports = router;
