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
} = require('@ai-fleet/shared/store');
const { getProjectsWithLabels, getAllProjectLabels } = require('@ai-fleet/shared/linear');
const { asyncHandler } = require('@ai-fleet/shared/util');
const { CONFIG } = require('@ai-fleet/shared/config');
const scheduler = require('@ai-fleet/shared/agent/scheduler');
const { llmReady } = require('@ai-fleet/shared/agent/llm');
const localIntelligence = require('@ai-fleet/shared/agent/local-intelligence');

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
  const provider = settings.llmProvider || 'ollama';
  const localProvider = settings.localLlmProvider || settings.llmProvider || 'ollama';
  res.json({
    ...scheduler.getStatus(),
    assumedRole: getAssumedRole(),
    llmConfigured: llmReady(settings),
    llmProvider: provider,
    // Model for the active provider — used for the dashboard's LLM pill.
    activeModel: activeModelFor(provider, settings),
    localLlmProvider: localProvider,
    localActiveModel: activeModelFor(localProvider, settings),
    ollamaModel: settings.ollamaModel,
    lmstudioModel: settings.lmstudioModel,
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

// POST /api/agent/enrich-input — turn short user notes into a clearer brief via
// the configured LOCAL role only (Ollama / LM Studio; never a hosted fallback).
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
