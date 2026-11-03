'use strict';

const express = require('express');
const {
  getApiKey,
  getSettings,
  patchSettings,
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
  listConversations,
  getConversation,
  addConversation,
  appendConversationMessages,
  updateConversation,
  removeConversation,
  getApprovalGate,
  listApprovalGates,
} = require('@ai-fleet/shared/store');
const { getProjectsWithLabels, getAllProjectLabels } = require('@ai-fleet/shared/linear');
const { asyncHandler } = require('@ai-fleet/shared/util');
const { CONFIG } = require('@ai-fleet/shared/config');
const { SENTINEL_TOKEN, projectEgressHeaders } = require('@ai-fleet/shared/egress');
const { currentWorkspaceContext } = require('@ai-fleet/shared/store/workspace-context');
const scheduler = require('@ai-fleet/shared/agent/scheduler');
const { llmReady, providerForRole } = require('@ai-fleet/shared/agent/llm');
const localIntelligence = require('@ai-fleet/shared/agent/local-intelligence');
const { applySettingsPatch, sanitizeSettingsPatch } = require('@ai-fleet/shared/agent/settings-patch');
const workspaceRouter = require('@ai-fleet/shared/agent/workspace-router');
const { searchDocuments } = require('@ai-fleet/shared/agent/knowledge-search');
const memory = require('@ai-fleet/shared/agent/memory');
const businessPipeline = require('@ai-fleet/shared/agent/business-pipeline');
const approvalGate = require('@ai-fleet/shared/agent/approval-gate');
const conversations = require('@ai-fleet/shared/agent/conversations');
const workspaceEvents = require('@ai-fleet/shared/agent/workspace-events');
const { normalizeEventContext, matchesEventContext } = require('@ai-fleet/shared/messaging/events');
const { redactSecrets } = require('@ai-fleet/shared/agent/tools/exec');
const attachmentsService = require('@ai-fleet/shared/attachments/service');
const {
  getGatewayStatus,
  getProjectSandboxStatus,
  ensureProjectSandbox,
  stopProjectSandbox,
  startProjectSandbox,
  deleteProjectSandbox,
  changeSandboxImage,
  listSandboxes,
  chatWithProjectSandbox,
  execInSandbox,
  execInteractiveSandboxCommand,
  autocompleteSandboxInput,
  syncNvidiaSecrets,
  resolveOpenShellWorkspace,
  normalizeSandboxName,
  getSampleNetworkPolicy,
  runSandboxSecurityChecks,
  buildOrgImagePullSecretManifest,
  FREE_OPENROUTER_MODELS,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_IMAGE,
  SUPPORTED_SANDBOX_IMAGES,
} = require('@ai-fleet/shared/agent/openshell');
const { getOrgFundStatus } = require('@ai-fleet/shared/billing/gate');

const REF_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CONV_ID_PATTERN = /^conv_[A-Za-z0-9_-]{1,64}$/;
const GATE_ID_PATTERN = /^gate_[A-Za-z0-9_-]{1,64}$/;
const GATE_STATUSES = Object.freeze(['awaiting-approval', 'approved', 'auto-approved', 'proceeded', 'superseded']);

// Server-side defense-in-depth for secret leakage. The browser strips secrets
// before sending (public/js/secret-scan.mjs), but the API is the real trust
// boundary — client checks can be bypassed by calling this endpoint directly.
// So every user-text field is scrubbed again with the shared redactor before it
// is classified, searched, enriched, or persisted. Generous cap so ordinary
// messages are never truncated; the 1mb express.json limit bounds the request.
const MAX_REDACT_BYTES = 1_000_000;
const redactUserText = (value) => redactSecrets(String(value == null ? '' : value), [], MAX_REDACT_BYTES);

const router = express.Router();

function requestWorkspaceContext(req) {
  const getHeader = (name) => {
    if (req && typeof req.get === 'function') return req.get(name);
    return req && req.headers ? req.headers[name] : undefined;
  };
  return normalizeEventContext({
    organizationId: getHeader('x-ai-fleet-organization-id') || '',
    projectId: getHeader('x-ai-fleet-project-id') || '',
  });
}

function jobsForContext(context, kind) {
  const jobs = listJobs(kind);
  // Auth-disabled/local installs do not send selection headers. Preserve their
  // existing single-workspace behavior instead of hiding legacy jobs.
  if (!context.organizationId) return jobs;
  return jobs.filter((job) => matchesEventContext(job, context));
}

function jobsForRequest(req, kind) {
  return jobsForContext(requestWorkspaceContext(req), kind);
}

function recordsForRequest(req, records) {
  const context = requestWorkspaceContext(req);
  // No headers is the trusted, auth-disabled local-development contract.
  if (!context.organizationId) return records;
  return records.filter((record) => matchesEventContext(record, context));
}

function recordForRequest(req, records, id) {
  return recordsForRequest(req, records).find((record) => record.id === id) || null;
}

function stampRequestContext(req, record = {}) {
  const context = requestWorkspaceContext(req);
  return {
    ...record,
    ...(context.organizationId ? { orgId: context.organizationId } : {}),
    ...(context.projectId ? { nativeProjectId: context.projectId } : {}),
  };
}

function schedulerStatusForContext(context) {
  return scheduler.getStatus(context);
}

function conversationForRequest(req, id) {
  const conversation = getConversation(id);
  return conversation && matchesEventContext(conversation, requestWorkspaceContext(req))
    ? conversation
    : null;
}

// Deps for the DELETE-cascade call into attachmentsService below. The full
// attachments router (agent-attachments.js) builds its own copy of this —
// duplicated rather than imported to avoid a circular require (that router
// is required FROM this file).
function attachmentDeps(context) {
  return {
    embeddingApiKey: CONFIG.EGRESS_PROXY_URL ? SENTINEL_TOKEN : getSettings().antigravityApiKey || '',
    workspaceContext: context,
  };
}

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
  if (provider === 'huggingface') return settings.huggingfaceModel;
  if (provider === 'antigravity') return settings.antigravityModel || CONFIG.ANTIGRAVITY.defaultModel;
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
    // Minutes to hold an amber/red requirement gate before auto-approving (1 min – 7 days).
    evaluationApprovalWaitMinutes: clampInt(b.evaluationApprovalWaitMinutes, 1, 10080, current.evaluationApprovalWaitMinutes),
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
    const host = String(
      CONFIG.EGRESS_PROXY_URL ? CONFIG.OLLAMA.defaultHost : getSettings().ollamaHost || CONFIG.OLLAMA.defaultHost
    ).replace(/\/$/, '');
    const headers = CONFIG.EGRESS_PROXY_URL ? projectEgressHeaders(currentWorkspaceContext()) : {};
    try {
      const resp = await fetch(`${host}/api/tags`, { headers, signal: AbortSignal.timeout(4000) });
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
    const host = String(
      CONFIG.EGRESS_PROXY_URL ? CONFIG.LMSTUDIO.defaultHost : getSettings().lmstudioHost || CONFIG.LMSTUDIO.defaultHost
    ).replace(/\/$/, '');
    const headers = CONFIG.EGRESS_PROXY_URL ? projectEgressHeaders(currentWorkspaceContext()) : {};
    try {
      const resp = await fetch(`${host}/v1/models`, { headers, signal: AbortSignal.timeout(4000) });
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
    const host = String(CONFIG.EGRESS_PROXY_URL ? CONFIG.OMLX.defaultHost : settings.omlxHost || CONFIG.OMLX.defaultHost)
      .replace(/\/v1\/?$/i, '')
      .replace(/\/$/, '');
    const headers = { Accept: 'application/json' };
    if (CONFIG.EGRESS_PROXY_URL) Object.assign(headers, projectEgressHeaders(currentWorkspaceContext()));
    if (CONFIG.EGRESS_PROXY_URL || settings.omlxApiKey) {
      headers.Authorization = `Bearer ${CONFIG.EGRESS_PROXY_URL ? SENTINEL_TOKEN : settings.omlxApiKey}`;
    }
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
  // A schedule toggle / cadence change is a status transition — push it to the
  // workspace stream so every open workspace updates without polling /status.
  const context = requestWorkspaceContext(req);
  workspaceEvents.publishAgentStatus(
    { ...schedulerStatusForContext(context), assumedRole: getAssumedRole() },
    context,
  );
  res.json({ config: next });
});

// GET /api/agent/status — scheduler + readiness for the dashboard.
router.get('/status', (req, res) => {
  const context = requestWorkspaceContext(req);
  const settings = getSettings();
  const config = getAgentConfig();
  const codexTokens = settings.codexTokens;
  // The planner runs on the `thinking` role, so the dashboard LLM pill reflects
  // that role's provider/model and readiness.
  const provider = providerForRole(settings, 'thinking');
  const byomProvider = settings.byomProvider || settings.llmProvider || 'ollama';
  res.json({
    ...schedulerStatusForContext(context),
    assumedRole: getAssumedRole(),
    llmConfigured: llmReady(settings, 'thinking'),
    llmProvider: provider,
    // Model for the active provider — used for the dashboard's LLM pill.
    activeModel: activeModelFor(provider, settings),
    byomProvider: byomProvider,
    byomActiveModel: activeModelFor(byomProvider, settings),
    ollamaModel: settings.ollamaModel,
    lmstudioModel: settings.lmstudioModel,
    omlxModel: settings.omlxModel,
    huggingfaceModel: settings.huggingfaceModel,
    antigravityModel: settings.antigravityModel,
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
  res.json({ jobs: jobsForRequest(req) });
});

/**
 * Resolve per-organization GitHub + OpenRouter + Container Image Registry secrets
 * for NVIDIA OpenShell sandbox loading.
 * Checks explicit request body overrides, S2S settings service vault/managed
 * resolver when configured, and per-organization store / process.env fallbacks.
 */
async function resolveProjectSecrets(req, { projectId, organizationId: explicitOrgId } = {}) {
  const settings = getSettings();
  const context = requestWorkspaceContext(req);
  const body = (req && req.body) || {};
  const query = (req && req.query) || {};

  const organizationId =
    explicitOrgId ||
    (typeof body.organizationId === 'string' && body.organizationId.trim()) ||
    (typeof query.organizationId === 'string' && query.organizationId.trim()) ||
    context.organizationId ||
    process.env.PROXY_ORG_ID ||
    process.env.FLEET_ORG_ID ||
    'default';

  const workspace = resolveOpenShellWorkspace({
    workspace:
      (typeof body.workspace === 'string' && body.workspace.trim()) ||
      (typeof query.workspace === 'string' && query.workspace.trim()) ||
      settings.openshellWorkspace,
    organizationId,
    projectId,
  });

  let githubToken =
    (typeof body.githubToken === 'string' && body.githubToken.trim()) ||
    settings.githubToken ||
    process.env.GITHUB_TOKEN ||
    '';
  let openrouterApiKey =
    (typeof body.openrouterApiKey === 'string' && body.openrouterApiKey.trim()) ||
    settings.openrouterApiKey ||
    process.env.OPENROUTER_API_KEY ||
    '';
  const imageRegistryUrl =
    (typeof body.imageRegistryUrl === 'string' && body.imageRegistryUrl.trim()) ||
    settings.imageRegistryUrl ||
    process.env.ORG_IMAGE_REGISTRY_URL ||
    'ghcr.io';
  const imageRegistryUsername =
    (typeof body.imageRegistryUsername === 'string' && body.imageRegistryUsername.trim()) ||
    settings.imageRegistryUsername ||
    process.env.ORG_IMAGE_REGISTRY_USERNAME ||
    '';
  const imageRegistryPassword =
    (typeof body.imageRegistryPassword === 'string' && body.imageRegistryPassword.trim()) ||
    settings.imageRegistryPassword ||
    process.env.ORG_IMAGE_REGISTRY_PASSWORD ||
    '';
  const openshellUrl =
    (typeof body.openshellUrl === 'string' && body.openshellUrl.trim()) ||
    settings.openshellUrl ||
    CONFIG.OPENSHELL?.url ||
    'https://openshell.archagentix.com';

  // If S2S settings service is configured and tokens are not yet resolved, query S2S resolver
  const settingsBase = CONFIG.SERVICES && CONFIG.SERVICES.settingsUrl;
  if (settingsBase && (!githubToken || !openrouterApiKey)) {
    const orgId = context.organizationId || process.env.PROXY_ORG_ID || process.env.FLEET_ORG_ID || '';
    const effectiveProjectId = projectId || context.projectId || '';
    const orgInternalToken = String(process.env.ORG_INTERNAL_API_TOKEN || '').trim();
    const internalToken = String(process.env.INTERNAL_API_TOKEN || '').trim();
    try {
      let path = null;
      let headers = {};
      if (orgId && orgInternalToken) {
        const qs = effectiveProjectId ? `?project_id=${encodeURIComponent(effectiveProjectId)}` : '';
        path = `/api/v1/internal/s2s/orgs/${encodeURIComponent(orgId)}/secrets${qs}`;
        headers = { 'x-org-internal-token': orgInternalToken };
      } else if (internalToken) {
        path = '/api/v1/internal/s2s/managed-secrets';
        headers = { 'x-internal-token': internalToken };
      }
      if (path) {
        const resp = await fetch(`${String(settingsBase).replace(/\/$/, '')}${path}`, {
          headers,
          signal: AbortSignal.timeout(4000),
        });
        if (resp.ok) {
          const data = await resp.json();
          const secrets = (data && data.secrets) || {};
          if (!githubToken && secrets.githubToken && secrets.githubToken.value) {
            githubToken = String(secrets.githubToken.value).trim();
          }
          if (!openrouterApiKey && secrets.openrouterApiKey && secrets.openrouterApiKey.value) {
            openrouterApiKey = String(secrets.openrouterApiKey.value).trim();
          }
        }
      }
    } catch (_) {
      // Best-effort S2S secret lookup; fall back to local store settings
    }
  }

  return {
    organizationId,
    workspace,
    githubToken,
    openrouterApiKey,
    imageRegistryUrl,
    imageRegistryUsername,
    imageRegistryPassword,
    openshellUrl,
    repositoryUrl:
      (typeof body.repositoryUrl === 'string' && body.repositoryUrl.trim()) ||
      settings.repositoryUrl ||
      '',
  };
}

function upsertPersistedSandbox(sandboxDescriptor) {
  if (!sandboxDescriptor || !sandboxDescriptor.name) return [];
  const settings = getSettings();
  const list = Array.isArray(settings.openshellSandboxes)
    ? [...settings.openshellSandboxes]
    : [];
  const entry = {
    name: sandboxDescriptor.name,
    label: sandboxDescriptor.label || sandboxDescriptor.name,
    organizationId: sandboxDescriptor.organizationId || 'default',
    projectId: sandboxDescriptor.projectId || 'default',
    projectName: sandboxDescriptor.projectName || sandboxDescriptor.projectId || 'default',
    image: sandboxDescriptor.image || settings.openshellDefaultImage || DEFAULT_IMAGE,
    phase: sandboxDescriptor.phase || 'READY',
    workspace: sandboxDescriptor.workspace || settings.openshellWorkspace || 'tenant-a',
    exists: Boolean(sandboxDescriptor.exists ?? true),
    loadedAt: sandboxDescriptor.loadedAt || new Date().toISOString(),
  };
  const idx = list.findIndex((item) => item && item.name === entry.name);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...entry };
  } else {
    list.push(entry);
  }
  patchSettings({ openshellSandboxes: list });
  return list;
}

function removePersistedSandbox(sandboxName) {
  const settings = getSettings();
  const list = Array.isArray(settings.openshellSandboxes)
    ? settings.openshellSandboxes.filter((item) => item && item.name !== sandboxName)
    : [];
  patchSettings({ openshellSandboxes: list });
  return list;
}

// GET /api/agent/sandbox — NVIDIA OpenShell gateway health + active project sandbox status + multi-sandbox list + per-org policy & secret status.
router.get(
  '/sandbox',
  asyncHandler(async (req, res) => {
    const context = requestWorkspaceContext(req);
    const settings = getSettings();
    const organizationId =
      (typeof req.query.organizationId === 'string' && req.query.organizationId.trim()) ||
      context.organizationId ||
      'default';
    const projectId =
      (typeof req.query.projectId === 'string' && req.query.projectId.trim()) ||
      context.projectId ||
      'default';
    const projectName =
      (typeof req.query.projectName === 'string' && req.query.projectName.trim()) ||
      projectId;
    const requestedSandboxName =
      typeof req.query.sandboxName === 'string' && req.query.sandboxName.trim()
        ? req.query.sandboxName.trim()
        : undefined;
    const workspace = resolveOpenShellWorkspace({
      workspace:
        (typeof req.query.workspace === 'string' && req.query.workspace.trim()) ||
        settings.openshellWorkspace,
      organizationId,
      projectId,
    });
    const url = settings.openshellUrl || CONFIG.OPENSHELL?.url || 'https://openshell.archagentix.com';
    const defaultImage = settings.openshellDefaultImage || DEFAULT_IMAGE;

    const [gateway, sandbox, sandboxes] = await Promise.all([
      getGatewayStatus({ url, workspace }),
      getProjectSandboxStatus({
        url,
        workspace,
        organizationId,
        projectId,
        projectName,
        sandboxName: requestedSandboxName,
      }),
      listSandboxes({
        url,
        workspace,
        organizationId,
        projectId,
        projectName,
        persistedSandboxes: settings.openshellSandboxes || [],
      }),
    ]);

    const samplePolicy = getSampleNetworkPolicy({ workspace, organizationId, projectId });
    if (settings.openshellNetworkPolicy && String(settings.openshellNetworkPolicy).trim()) {
      samplePolicy.yaml = String(settings.openshellNetworkPolicy);
    }

    const hasGithubSecret = Boolean(
      sandbox?.secrets?.github?.configured || settings.githubToken || process.env.GITHUB_TOKEN
    );
    const hasOpenrouterSecret = Boolean(
      sandbox?.secrets?.openrouter?.configured || settings.openrouterApiKey || process.env.OPENROUTER_API_KEY
    );
    const hasImageRegistrySecret = Boolean(
      sandbox?.secrets?.imageRegistry?.configured ||
        (settings.imageRegistryUsername && settings.imageRegistryPassword) ||
        (process.env.ORG_IMAGE_REGISTRY_USERNAME && process.env.ORG_IMAGE_REGISTRY_PASSWORD)
    );

    res.json({
      gateway,
      sandbox: {
        ...sandbox,
        image: sandbox?.image || defaultImage,
        organizationId,
        workspace,
        freeModels: FREE_OPENROUTER_MODELS,
        defaultModel: DEFAULT_OPENROUTER_MODEL,
        supportedImages: SUPPORTED_SANDBOX_IMAGES,
        hasGithubSecret,
        hasOpenrouterSecret,
        hasImageRegistrySecret,
        imageRegistryUrl: settings.imageRegistryUrl || 'ghcr.io',
        imageRegistryUsername: settings.imageRegistryUsername || '',
      },
      sandboxes,
      defaultImage,
      supportedImages: SUPPORTED_SANDBOX_IMAGES,
      networkPolicy: samplePolicy,
      orgConfig: {
        organizationId,
        workspace,
        openshellUrl: url,
        defaultImage,
        supportedImages: SUPPORTED_SANDBOX_IMAGES,
        hasGithubSecret,
        hasOpenrouterSecret,
        hasImageRegistrySecret,
        imageRegistryUrl: settings.imageRegistryUrl || 'ghcr.io',
        imageRegistryUsername: settings.imageRegistryUsername || '',
        secretManifestYaml: buildOrgImagePullSecretManifest({
          organizationId,
          workspace,
          registryUrl: settings.imageRegistryUrl || 'ghcr.io',
          username: settings.imageRegistryUsername || '',
          password: hasImageRegistrySecret ? '***REDACTED***' : '',
        }),
      },
    });
  })
);

// GET /api/agent/sandboxes — List all OpenShell sandboxes for the user/project/organization.
router.get(
  '/sandboxes',
  asyncHandler(async (req, res) => {
    const context = requestWorkspaceContext(req);
    const settings = getSettings();
    const organizationId =
      (typeof req.query.organizationId === 'string' && req.query.organizationId.trim()) ||
      context.organizationId ||
      'default';
    const projectId =
      (typeof req.query.projectId === 'string' && req.query.projectId.trim()) ||
      context.projectId ||
      'default';
    const projectName =
      (typeof req.query.projectName === 'string' && req.query.projectName.trim()) ||
      projectId;
    const workspace = resolveOpenShellWorkspace({
      workspace:
        (typeof req.query.workspace === 'string' && req.query.workspace.trim()) ||
        settings.openshellWorkspace,
      organizationId,
      projectId,
    });
    const url = settings.openshellUrl || CONFIG.OPENSHELL?.url || 'https://openshell.archagentix.com';

    const sandboxes = await listSandboxes({
      url,
      workspace,
      organizationId,
      projectId,
      projectName,
      persistedSandboxes: settings.openshellSandboxes || [],
    });

    res.json({
      ok: true,
      sandboxes,
      defaultImage: settings.openshellDefaultImage || DEFAULT_IMAGE,
      supportedImages: SUPPORTED_SANDBOX_IMAGES,
    });
  })
);

// POST /api/agent/sandboxes — Create/provision a new named OpenShell sandbox (supports multiple sandboxes per user & custom image).
router.post(
  '/sandboxes',
  asyncHandler(async (req, res) => {
    const context = requestWorkspaceContext(req);
    const settings = getSettings();
    const body = req.body || {};
    const projectId =
      (typeof body.projectId === 'string' && body.projectId.trim()) ||
      context.projectId ||
      'default';
    const projectName =
      (typeof body.projectName === 'string' && body.projectName.trim()) ||
      projectId;
    const rawName =
      (typeof body.sandboxName === 'string' && body.sandboxName.trim()) ||
      (typeof body.name === 'string' && body.name.trim()) ||
      `sb-${projectName}-${Date.now().toString(36).slice(-4)}`;
    const sandboxName = normalizeSandboxName(rawName, projectId, projectName);
    const label =
      (typeof body.label === 'string' && body.label.trim()) ||
      (typeof body.name === 'string' && body.name.trim()) ||
      sandboxName;
    const image =
      (typeof body.image === 'string' && body.image.trim()) ||
      settings.openshellDefaultImage ||
      DEFAULT_IMAGE;

    const resolved = await resolveProjectSecrets(req, { projectId });
    const sandbox = await ensureProjectSandbox({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      projectName,
      sandboxName,
      label,
      image,
      recreate: Boolean(body.recreate),
      repositoryUrl: resolved.repositoryUrl,
      githubToken: resolved.githubToken,
      openrouterApiKey: resolved.openrouterApiKey,
      imageRegistryUrl: resolved.imageRegistryUrl,
      imageRegistryUsername: resolved.imageRegistryUsername,
      imageRegistryPassword: resolved.imageRegistryPassword,
    });

    const persisted = upsertPersistedSandbox(sandbox);
    const sandboxes = await listSandboxes({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      projectName,
      persistedSandboxes: persisted,
    });

    res.status(201).json({
      ok: true,
      sandbox,
      sandboxes,
    });
  })
);

// PATCH /api/agent/sandboxes/:sandboxName — Update a sandbox from backend or UI (change image, stop, start, or recreate).
router.patch(
  '/sandboxes/:sandboxName',
  asyncHandler(async (req, res) => {
    const context = requestWorkspaceContext(req);
    const body = req.body || {};
    const projectId =
      (typeof body.projectId === 'string' && body.projectId.trim()) ||
      context.projectId ||
      'default';
    const projectName =
      (typeof body.projectName === 'string' && body.projectName.trim()) ||
      projectId;
    const sandboxName = normalizeSandboxName(req.params.sandboxName, projectId, projectName);
    const resolved = await resolveProjectSecrets(req, { projectId });

    let sandbox;
    if (body.action === 'stop' || body.phase === 'STOPPED') {
      sandbox = await stopProjectSandbox({
        url: resolved.openshellUrl,
        workspace: resolved.workspace,
        organizationId: resolved.organizationId,
        projectId,
        projectName,
        sandboxName,
      });
    } else if (body.image && typeof body.image === 'string' && body.image.trim()) {
      sandbox = await changeSandboxImage({
        url: resolved.openshellUrl,
        workspace: resolved.workspace,
        organizationId: resolved.organizationId,
        projectId,
        projectName,
        sandboxName,
        label: body.label,
        image: body.image.trim(),
        repositoryUrl: resolved.repositoryUrl,
        githubToken: resolved.githubToken,
        openrouterApiKey: resolved.openrouterApiKey,
        imageRegistryUrl: resolved.imageRegistryUrl,
        imageRegistryUsername: resolved.imageRegistryUsername,
        imageRegistryPassword: resolved.imageRegistryPassword,
      });
    } else {
      sandbox = await startProjectSandbox({
        url: resolved.openshellUrl,
        workspace: resolved.workspace,
        organizationId: resolved.organizationId,
        projectId,
        projectName,
        sandboxName,
        label: body.label,
        repositoryUrl: resolved.repositoryUrl,
        githubToken: resolved.githubToken,
        openrouterApiKey: resolved.openrouterApiKey,
        imageRegistryUrl: resolved.imageRegistryUrl,
        imageRegistryUsername: resolved.imageRegistryUsername,
        imageRegistryPassword: resolved.imageRegistryPassword,
      });
    }

    const persisted = upsertPersistedSandbox(sandbox);
    const sandboxes = await listSandboxes({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      projectName,
      persistedSandboxes: persisted,
    });

    res.json({
      ok: true,
      sandbox,
      sandboxes,
    });
  })
);

// DELETE /api/agent/sandboxes/:sandboxName — Delete a named OpenShell sandbox.
router.delete(
  '/sandboxes/:sandboxName',
  asyncHandler(async (req, res) => {
    const context = requestWorkspaceContext(req);
    const projectId =
      (typeof req.query.projectId === 'string' && req.query.projectId.trim()) ||
      context.projectId ||
      'default';
    const projectName =
      (typeof req.query.projectName === 'string' && req.query.projectName.trim()) ||
      projectId;
    const sandboxName = normalizeSandboxName(req.params.sandboxName, projectId, projectName);
    const resolved = await resolveProjectSecrets(req, { projectId });

    const deleted = await deleteProjectSandbox({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      projectName,
      sandboxName,
    });
    const persisted = removePersistedSandbox(sandboxName);
    const sandboxes = await listSandboxes({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      projectName,
      persistedSandboxes: persisted,
    });

    res.json({
      ok: true,
      deleted,
      sandboxes,
    });
  })
);

// POST /api/agent/sandbox/load — Load/provision NVIDIA OpenShell sandbox for a project (or specific sandboxName & image)
// with per-organization GitHub, OpenRouter, and Container Image Registry secrets synced.
router.post(
  '/sandbox/load',
  asyncHandler(async (req, res) => {
    const context = requestWorkspaceContext(req);
    const settings = getSettings();
    const body = req.body || {};
    const projectId =
      (typeof body.projectId === 'string' && body.projectId.trim()) ||
      context.projectId ||
      'default';
    const projectName =
      (typeof body.projectName === 'string' && body.projectName.trim()) ||
      projectId;
    const sandboxName =
      typeof body.sandboxName === 'string' && body.sandboxName.trim()
        ? body.sandboxName.trim()
        : undefined;
    const image =
      (typeof body.image === 'string' && body.image.trim()) ||
      settings.openshellDefaultImage ||
      undefined;

    const resolved = await resolveProjectSecrets(req, { projectId });
    const sandbox = await ensureProjectSandbox({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      projectName,
      sandboxName,
      label: typeof body.label === 'string' ? body.label.trim() : undefined,
      image,
      recreate: Boolean(body.recreate),
      repositoryUrl: resolved.repositoryUrl,
      githubToken: resolved.githubToken,
      openrouterApiKey: resolved.openrouterApiKey,
      imageRegistryUrl: resolved.imageRegistryUrl,
      imageRegistryUsername: resolved.imageRegistryUsername,
      imageRegistryPassword: resolved.imageRegistryPassword,
    });

    if (typeof body.image === 'string' && body.image.trim() && body.setAsDefault) {
      patchSettings({ openshellDefaultImage: body.image.trim() });
    }
    const persisted = upsertPersistedSandbox(sandbox);
    const sandboxes = await listSandboxes({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      projectName,
      persistedSandboxes: persisted,
    });

    res.json({
      ok: true,
      sandbox: {
        ...sandbox,
        hasGithubSecret: Boolean(resolved.githubToken || sandbox?.secrets?.github?.configured),
        hasOpenrouterSecret: Boolean(
          resolved.openrouterApiKey || sandbox?.secrets?.openrouter?.configured
        ),
        hasImageRegistrySecret: Boolean(
          (resolved.imageRegistryUsername && resolved.imageRegistryPassword) ||
            sandbox?.secrets?.imageRegistry?.configured
        ),
      },
      sandboxes,
    });
  })
);

// POST /api/agent/sandbox/image — Dedicated backend & UI endpoint to change a sandbox's container image.
router.post(
  '/sandbox/image',
  asyncHandler(async (req, res) => {
    const context = requestWorkspaceContext(req);
    const body = req.body || {};
    const image = typeof body.image === 'string' ? body.image.trim() : '';
    if (!image) {
      return res.status(400).json({ error: 'image is required.' });
    }
    const projectId =
      (typeof body.projectId === 'string' && body.projectId.trim()) ||
      context.projectId ||
      'default';
    const projectName =
      (typeof body.projectName === 'string' && body.projectName.trim()) ||
      projectId;
    const sandboxName =
      typeof body.sandboxName === 'string' && body.sandboxName.trim()
        ? body.sandboxName.trim()
        : undefined;

    if (body.setAsDefault !== false) {
      patchSettings({ openshellDefaultImage: image });
    }

    const resolved = await resolveProjectSecrets(req, { projectId });
    const sandbox = await changeSandboxImage({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      projectName,
      sandboxName,
      image,
      repositoryUrl: resolved.repositoryUrl,
      githubToken: resolved.githubToken,
      openrouterApiKey: resolved.openrouterApiKey,
      imageRegistryUrl: resolved.imageRegistryUrl,
      imageRegistryUsername: resolved.imageRegistryUsername,
      imageRegistryPassword: resolved.imageRegistryPassword,
    });

    const persisted = upsertPersistedSandbox(sandbox);
    const sandboxes = await listSandboxes({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      projectName,
      persistedSandboxes: persisted,
    });

    res.json({
      ok: true,
      sandbox,
      sandboxes,
      defaultImage: getSettings().openshellDefaultImage || image,
    });
  })
);

// POST /api/agent/sandbox/stop — Stop a running OpenShell sandbox pod.
router.post(
  '/sandbox/stop',
  asyncHandler(async (req, res) => {
    const context = requestWorkspaceContext(req);
    const body = req.body || {};
    const projectId =
      (typeof body.projectId === 'string' && body.projectId.trim()) ||
      context.projectId ||
      'default';
    const projectName =
      (typeof body.projectName === 'string' && body.projectName.trim()) ||
      projectId;
    const sandboxName =
      typeof body.sandboxName === 'string' && body.sandboxName.trim()
        ? body.sandboxName.trim()
        : undefined;

    const resolved = await resolveProjectSecrets(req, { projectId });
    const sandbox = await stopProjectSandbox({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      projectName,
      sandboxName,
    });

    const persisted = upsertPersistedSandbox(sandbox);
    const sandboxes = await listSandboxes({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      projectName,
      persistedSandboxes: persisted,
    });

    res.json({
      ok: true,
      sandbox,
      sandboxes,
    });
  })
);

// POST /api/agent/sandbox/start — Start a stopped OpenShell sandbox pod.
router.post(
  '/sandbox/start',
  asyncHandler(async (req, res) => {
    const context = requestWorkspaceContext(req);
    const body = req.body || {};
    const projectId =
      (typeof body.projectId === 'string' && body.projectId.trim()) ||
      context.projectId ||
      'default';
    const projectName =
      (typeof body.projectName === 'string' && body.projectName.trim()) ||
      projectId;
    const sandboxName =
      typeof body.sandboxName === 'string' && body.sandboxName.trim()
        ? body.sandboxName.trim()
        : undefined;
    const image =
      typeof body.image === 'string' && body.image.trim() ? body.image.trim() : undefined;

    const resolved = await resolveProjectSecrets(req, { projectId });
    const sandbox = await startProjectSandbox({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      projectName,
      sandboxName,
      image,
      repositoryUrl: resolved.repositoryUrl,
      githubToken: resolved.githubToken,
      openrouterApiKey: resolved.openrouterApiKey,
      imageRegistryUrl: resolved.imageRegistryUrl,
      imageRegistryUsername: resolved.imageRegistryUsername,
      imageRegistryPassword: resolved.imageRegistryPassword,
    });

    const persisted = upsertPersistedSandbox(sandbox);
    const sandboxes = await listSandboxes({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      projectName,
      persistedSandboxes: persisted,
    });

    res.json({
      ok: true,
      sandbox,
      sandboxes,
    });
  })
);

// POST /api/agent/sandbox/chat — Direct chat or terminal turn against the project's NVIDIA OpenShell sandbox.
router.post(
  '/sandbox/chat',
  asyncHandler(async (req, res) => {
    const context = requestWorkspaceContext(req);
    const body = req.body || {};
    const rawMessage = typeof body.message === 'string' ? body.message : typeof body.input === 'string' ? body.input : '';
    const cleanMessage = redactUserText(rawMessage).trim();
    if (!cleanMessage) {
      return res.status(400).json({ error: 'message is required.' });
    }

    const projectId =
      (typeof body.projectId === 'string' && body.projectId.trim()) ||
      context.projectId ||
      'default';
    const projectName =
      (typeof body.projectName === 'string' && body.projectName.trim()) ||
      projectId;
    const sandboxName =
      typeof body.sandboxName === 'string' && body.sandboxName.trim()
        ? body.sandboxName.trim()
        : undefined;
    const image =
      typeof body.image === 'string' && body.image.trim() ? body.image.trim() : undefined;
    const model =
      typeof body.model === 'string' && body.model.trim()
        ? body.model.trim()
        : DEFAULT_OPENROUTER_MODEL;

    const resolved = await resolveProjectSecrets(req, { projectId });
    const result = await chatWithProjectSandbox({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      projectName,
      sandboxName,
      image,
      repositoryUrl: resolved.repositoryUrl,
      message: cleanMessage,
      history: Array.isArray(body.history) ? body.history : [],
      githubToken: resolved.githubToken,
      openrouterApiKey: resolved.openrouterApiKey,
      imageRegistryUrl: resolved.imageRegistryUrl,
      imageRegistryUsername: resolved.imageRegistryUsername,
      imageRegistryPassword: resolved.imageRegistryPassword,
      model,
    });

    upsertPersistedSandbox(result.sandbox);

    res.json({
      ok: true,
      reply: result.reply,
      model: result.model,
      sandbox: result.sandbox,
      commandOutput: result.commandOutput,
    });
  })
);

// POST /api/agent/sandbox/exec — Execute an interactive shell command or tab-autocomplete inside the running OpenShell sandbox pod.
router.post(
  '/sandbox/exec',
  asyncHandler(async (req, res) => {
    const context = requestWorkspaceContext(req);
    const body = req.body || {};
    const projectId =
      (typeof body.projectId === 'string' && body.projectId.trim()) ||
      context.projectId ||
      'default';
    const projectName =
      (typeof body.projectName === 'string' && body.projectName.trim()) ||
      projectId;
    const sandboxName =
      typeof body.sandboxName === 'string' && body.sandboxName.trim()
        ? body.sandboxName.trim()
        : undefined;

    const resolved = await resolveProjectSecrets(req, { projectId });

    if (body.autocomplete) {
      const completion = await autocompleteSandboxInput({
        url: resolved.openshellUrl,
        workspace: resolved.workspace,
        organizationId: resolved.organizationId,
        projectId,
        projectName,
        sandboxName,
        prefix: typeof body.prefix === 'string' ? body.prefix : '',
        cwd: typeof body.cwd === 'string' ? body.cwd : '/workspace',
      });
      return res.json({
        ok: true,
        ...completion,
      });
    }

    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (!command) {
      return res.status(400).json({ error: 'command is required.' });
    }

    const sandbox = await ensureProjectSandbox({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      projectName,
      sandboxName,
      image: typeof body.image === 'string' && body.image.trim() ? body.image.trim() : undefined,
      repositoryUrl: resolved.repositoryUrl,
      githubToken: resolved.githubToken,
      openrouterApiKey: resolved.openrouterApiKey,
      imageRegistryUrl: resolved.imageRegistryUrl,
      imageRegistryUsername: resolved.imageRegistryUsername,
      imageRegistryPassword: resolved.imageRegistryPassword,
    });

    if (body.interactive !== false) {
      const execResult = await execInteractiveSandboxCommand({
        url: resolved.openshellUrl,
        workspace: resolved.workspace,
        organizationId: resolved.organizationId,
        projectId,
        projectName,
        sandboxName: sandbox.name,
        command,
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
        stdin: typeof body.stdin === 'string' ? body.stdin : undefined,
      });

      return res.json({
        ok: true,
        sandbox,
        sandboxName: sandbox.name,
        image: sandbox.image,
        command,
        stdout: execResult.stdout,
        stderr: execResult.stderr,
        exitCode: execResult.exitCode,
        cwd: execResult.cwd,
        user: execResult.user,
        hostname: execResult.hostname,
      });
    }

    const wrappedCmd = `[ -f /tmp/.aifleet-env ] && . /tmp/.aifleet-env; export PATH="/sandbox/.local/bin:/usr/local/bin:$PATH"; cd /workspace 2>/dev/null || true; ${command}`;
    const execResult = await execInSandbox({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      sandboxName: sandbox.name,
      command: ['sh', '-c', wrappedCmd],
    });

    res.json({
      ok: true,
      sandbox,
      sandboxName: sandbox.name,
      image: sandbox.image,
      command,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      exitCode: execResult.exitCode,
      cwd: '/workspace',
    });
  })
);

// GET /api/agent/sandbox/policy — Get the organization's OpenShell Kubernetes NetworkPolicy.
router.get('/sandbox/policy', (req, res) => {
  const context = requestWorkspaceContext(req);
  const settings = getSettings();
  const organizationId =
    (typeof req.query.organizationId === 'string' && req.query.organizationId.trim()) ||
    context.organizationId ||
    'default';
  const projectId =
    (typeof req.query.projectId === 'string' && req.query.projectId.trim()) ||
    context.projectId ||
    'default';
  const workspace = resolveOpenShellWorkspace({
    workspace: settings.openshellWorkspace,
    organizationId,
    projectId,
  });
  const policy = getSampleNetworkPolicy({ workspace, organizationId, projectId });
  if (settings.openshellNetworkPolicy && String(settings.openshellNetworkPolicy).trim()) {
    policy.yaml = String(settings.openshellNetworkPolicy);
  }
  res.json({ ok: true, networkPolicy: policy });
});

// POST /api/agent/sandbox/policy — Save per-organization OpenShell NetworkPolicy YAML.
router.post('/sandbox/policy', (req, res) => {
  const context = requestWorkspaceContext(req);
  const body = req.body || {};
  const yaml = typeof body.yaml === 'string' ? body.yaml.trim() : '';
  const organizationId =
    (typeof body.organizationId === 'string' && body.organizationId.trim()) ||
    context.organizationId ||
    'default';
  const projectId =
    (typeof body.projectId === 'string' && body.projectId.trim()) ||
    context.projectId ||
    'default';
  const workspace = resolveOpenShellWorkspace({
    workspace: body.workspace || getSettings().openshellWorkspace,
    organizationId,
    projectId,
  });
  patchSettings({
    openshellWorkspace: workspace,
    ...(yaml ? { openshellNetworkPolicy: yaml } : {}),
  });
  const policy = getSampleNetworkPolicy({ workspace, organizationId, projectId });
  if (yaml) policy.yaml = yaml;
  res.json({ ok: true, networkPolicy: policy });
});

// POST /api/agent/sandbox/security-check — Run live security & isolation verification on the OpenShell sandbox.
router.post(
  '/sandbox/security-check',
  asyncHandler(async (req, res) => {
    const context = requestWorkspaceContext(req);
    const body = req.body || {};
    const projectId =
      (typeof body.projectId === 'string' && body.projectId.trim()) ||
      context.projectId ||
      'default';
    const projectName =
      (typeof body.projectName === 'string' && body.projectName.trim()) ||
      projectId;
    const sandboxName =
      typeof body.sandboxName === 'string' && body.sandboxName.trim()
        ? body.sandboxName.trim()
        : undefined;
    const resolved = await resolveProjectSecrets(req, { projectId });
    const report = await runSandboxSecurityChecks({
      url: resolved.openshellUrl,
      workspace: resolved.workspace,
      organizationId: resolved.organizationId,
      projectId,
      projectName,
      sandboxName,
    });
    res.json({ ok: true, report });
  })
);

// PUT /api/agent/sandbox/org-config — Save & sync per-organization OpenShell secrets, default image, and container image push/pull registry credentials.
router.put(
  '/sandbox/org-config',
  asyncHandler(async (req, res) => {
    const context = requestWorkspaceContext(req);
    const body = req.body || {};
    const current = getSettings();
    const organizationId =
      (typeof body.organizationId === 'string' && body.organizationId.trim()) ||
      context.organizationId ||
      'default';
    const projectId =
      (typeof body.projectId === 'string' && body.projectId.trim()) ||
      context.projectId ||
      'default';
    const projectName =
      (typeof body.projectName === 'string' && body.projectName.trim()) ||
      projectId;
    const sandboxName =
      typeof body.sandboxName === 'string' && body.sandboxName.trim()
        ? body.sandboxName.trim()
        : undefined;

    const workspace = resolveOpenShellWorkspace({
      workspace:
        typeof body.workspace === 'string' && body.workspace.trim()
          ? body.workspace.trim()
          : current.openshellWorkspace,
      organizationId,
      projectId,
    });

    const patch = { openshellWorkspace: workspace };
    if (typeof body.openshellUrl === 'string' && body.openshellUrl.trim()) {
      patch.openshellUrl = body.openshellUrl.trim();
    }
    const requestedImage =
      (typeof body.defaultImage === 'string' && body.defaultImage.trim()) ||
      (typeof body.image === 'string' && body.image.trim()) ||
      '';
    if (requestedImage) {
      patch.openshellDefaultImage = requestedImage;
    }
    if (typeof body.githubToken === 'string' && body.githubToken.trim()) {
      patch.githubToken = body.githubToken.trim();
    }
    if (typeof body.openrouterApiKey === 'string' && body.openrouterApiKey.trim()) {
      patch.openrouterApiKey = body.openrouterApiKey.trim();
    }
    if (typeof body.imageRegistryUrl === 'string' && body.imageRegistryUrl.trim()) {
      patch.imageRegistryUrl = body.imageRegistryUrl.trim();
    }
    if (typeof body.imageRegistryUsername === 'string') {
      patch.imageRegistryUsername = body.imageRegistryUsername.trim();
    }
    if (typeof body.imageRegistryPassword === 'string' && body.imageRegistryPassword.trim()) {
      patch.imageRegistryPassword = body.imageRegistryPassword.trim();
    }
    if (typeof body.openshellNetworkPolicy === 'string' && body.openshellNetworkPolicy.trim()) {
      patch.openshellNetworkPolicy = body.openshellNetworkPolicy.trim();
    }

    patchSettings(patch);
    const updated = getSettings();
    const url = updated.openshellUrl || CONFIG.OPENSHELL?.url;

    const syncResult = await syncNvidiaSecrets({
      url,
      workspace,
      organizationId,
      projectId,
      githubToken: updated.githubToken,
      openrouterApiKey: updated.openrouterApiKey,
      imageRegistryUrl: updated.imageRegistryUrl,
      imageRegistryUsername: updated.imageRegistryUsername,
      imageRegistryPassword: updated.imageRegistryPassword,
    });

    let sandbox = null;
    if (body.stopSandbox) {
      sandbox = await stopProjectSandbox({
        url,
        workspace,
        organizationId,
        projectId,
        projectName,
        sandboxName,
      });
      upsertPersistedSandbox(sandbox);
    } else if (body.startSandbox || requestedImage) {
      sandbox = await ensureProjectSandbox({
        url,
        workspace,
        organizationId,
        projectId,
        projectName,
        sandboxName,
        image: requestedImage || updated.openshellDefaultImage || DEFAULT_IMAGE,
        recreate: Boolean(requestedImage),
        githubToken: updated.githubToken,
        openrouterApiKey: updated.openrouterApiKey,
        imageRegistryUrl: updated.imageRegistryUrl,
        imageRegistryUsername: updated.imageRegistryUsername,
        imageRegistryPassword: updated.imageRegistryPassword,
      });
      upsertPersistedSandbox(sandbox);
    }

    res.json({
      ok: true,
      sandbox,
      orgConfig: {
        organizationId,
        workspace,
        openshellUrl: url,
        defaultImage: updated.openshellDefaultImage || DEFAULT_IMAGE,
        supportedImages: SUPPORTED_SANDBOX_IMAGES,
        hasGithubSecret: Boolean(updated.githubToken),
        hasOpenrouterSecret: Boolean(updated.openrouterApiKey),
        hasImageRegistrySecret: Boolean(
          updated.imageRegistryUsername && updated.imageRegistryPassword
        ),
        imageRegistryUrl: updated.imageRegistryUrl || 'ghcr.io',
        imageRegistryUsername: updated.imageRegistryUsername || '',
        providers: syncResult.providers,
        secretManifestYaml: syncResult.secrets?.imageRegistry?.secretManifestYaml || '',
      },
    });
  })
);

// POST /api/agent/message — deterministic intent and safety gate for the Agent
// omnibox. Greetings and rejected abuse never reach retrieval, a model, tools,
// or a mutation. Business/general requests may use the configured local model
// only to enrich their bounded, already-routed context, and also route to the
// active project's NVIDIA OpenShell sandbox chat when enabled.
router.post(
  '/message',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const route = workspaceRouter.classifyIntent(redactUserText(body.input));
    let enrichment = null;
    let warning = null;
    let memoryDraft = null;
    let canPrepare = false;
    let sandboxChat = null;

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

    // Route chat box messages to the project's NVIDIA OpenShell sandbox chat
    // when a project sandbox is active or explicitly requested (and not rejected
    // by the safety gate or a simple salutation).
    if (!route.rejected && route.intent !== 'salutation' && body.sandboxChat === true && route.input) {
      const context = requestWorkspaceContext(req);
      const projectId =
        (typeof body.projectId === 'string' && body.projectId.trim()) ||
        context.projectId ||
        'default';
      const projectName =
        (typeof body.projectName === 'string' && body.projectName.trim()) ||
        projectId;
      try {
        const resolved = await resolveProjectSecrets(req, { projectId });
        sandboxChat = await chatWithProjectSandbox({
          url: resolved.openshellUrl,
          projectId,
          projectName,
          repositoryUrl: resolved.repositoryUrl,
          message: route.input,
          history: Array.isArray(body.history) ? body.history : [],
          githubToken: resolved.githubToken,
          openrouterApiKey: resolved.openrouterApiKey,
        });
      } catch (err) {
        sandboxChat = {
          error: err && err.message ? err.message : String(err),
        };
      }
    }

    res.json({ route, enrichment, warning, memoryDraft, canPrepare, sandboxChat });
  })
);

// POST /api/agent/knowledge-search — bounded, read-only lexical retrieval over
// the workspace's README/docs corpus. It returns real relative paths and
// snippets, never arbitrary files, absolute paths, credentials, or model prose.
router.post('/knowledge-search', (req, res) => {
  res.json(searchDocuments(redactUserText(req.body && (req.body.query || req.body.input))));
});

// POST /api/agent/memory-search — typed, read-only recall across the five memory
// scopes, blended with reviewed documentation. Scope is detected from the query
// when not explicitly supplied. Never returns secrets or absolute paths.
router.post('/memory-search', (req, res) => {
  const body = req.body || {};
  const query = redactUserText(typeof body.query === 'string' ? body.query : typeof body.input === 'string' ? body.input : '');
  const requested = typeof body.scope === 'string' ? body.scope.toLowerCase() : '';
  const scope = memory.MEMORY_SCOPES.includes(requested) ? requested : memory.detectMemoryScope(query);
  const results = memory.searchMemories(query, recordsForRequest(req, listMemories()), { scope });
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
  const record = addMemory(stampRequestContext(req, memory.normalizeMemory(req.body)));
  res.status(201).json({ memory: record });
});

// GET /api/agent/memory — list stored memories, optionally filtered by scope/refId.
router.get('/memory', (req, res) => {
  const requested = typeof req.query.scope === 'string' ? req.query.scope.toLowerCase() : '';
  const scope = memory.MEMORY_SCOPES.includes(requested) ? requested : undefined;
  const refId = typeof req.query.refId === 'string' && REF_ID_PATTERN.test(req.query.refId) ? req.query.refId : undefined;
  res.json({ memories: recordsForRequest(req, listMemories({ scope, refId })) });
});

// DELETE /api/agent/memory/:id — remove one stored memory.
router.delete('/memory/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!/^mem_[A-Za-z0-9-]{1,80}$/.test(id)) return res.status(400).json({ error: 'Invalid memory id.' });
  if (!recordForRequest(req, listMemories(), id) || !removeMemory(id)) {
    return res.status(404).json({ error: 'Memory not found.' });
  }
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
      business = recordForRequest(req, readStore().businesses, body.businessId);
    }
    const payload = await businessPipeline.prepareBusiness({
      input: typeof body.input === 'string' ? body.input : '',
      business,
      settings: getSettings(),
      assumedRole: getAssumedRole(),
      ...stampRequestContext(req),
    });
    res.json({ business: payload });
  })
);

// POST /api/agent/business/evaluate — requirement-readiness preflight (step 0),
// run BEFORE design/scheduling. Returns a traffic-light signal + acceptance
// criteria. Green proceeds straight to the pipeline (no gate); amber/red opens a
// durable approval gate that holds the pipeline pending human refinement. The
// signal is computed server-side from readiness scores — the model cannot force
// green (business-pipeline normalizeEvaluation clamps it down).
router.post(
  '/business/evaluate',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    let business = null;
    if (typeof body.businessId === 'string' && REF_ID_PATTERN.test(body.businessId)) {
      business = recordForRequest(req, readStore().businesses, body.businessId);
    }
    const conversationId = typeof body.conversationId === 'string' && CONV_ID_PATTERN.test(body.conversationId)
      ? body.conversationId
      : null;

    const result = await businessPipeline.evaluateRequirement({
      input: typeof body.input === 'string' ? body.input : '',
      settings: getSettings(),
      business,
    });

    if (result.blocked) return res.json({ blocked: true, answer: result.answer, signal: result.signal });
    if (result.signal === 'green') return res.json({ evaluation: result.evaluation, signal: 'green', gate: null });

    const gate = approvalGate.createGate(stampRequestContext(req, {
      requirement: result.goal,
      businessId: business ? business.id : null,
      conversationId,
      evaluation: result.evaluation,
      signal: result.signal,
      waitMinutes: getAgentConfig().evaluationApprovalWaitMinutes,
    }));
    res.json({ evaluation: result.evaluation, signal: result.signal, gate });
  })
);

// GET /api/agent/business/gates — list gates (optional ?businessId= &status=).
router.get('/business/gates', (req, res) => {
  const filter = {};
  if (typeof req.query.businessId === 'string' && REF_ID_PATTERN.test(req.query.businessId)) filter.businessId = req.query.businessId;
  if (typeof req.query.status === 'string' && GATE_STATUSES.includes(req.query.status)) filter.status = req.query.status;
  res.json({ gates: recordsForRequest(req, listApprovalGates(filter)) });
});

// GET /api/agent/business/gates/:id — one gate (front-end polls for the countdown
// and to auto-advance when status flips to proceeded).
router.get('/business/gates/:id', (req, res) => {
  if (!GATE_ID_PATTERN.test(req.params.id)) return res.status(400).json({ error: 'Invalid gate id.' });
  const gate = recordForRequest(req, listApprovalGates(), req.params.id);
  if (!gate) return res.status(404).json({ error: 'Approval gate not found.' });
  res.json({ gate });
});

// POST /api/agent/business/gates/:id/approve — human "approve & proceed now".
router.post(
  '/business/gates/:id/approve',
  asyncHandler(async (req, res) => {
    if (!GATE_ID_PATTERN.test(req.params.id)) return res.status(400).json({ error: 'Invalid gate id.' });
    if (!recordForRequest(req, listApprovalGates(), req.params.id)) {
      return res.status(404).json({ error: 'Approval gate not found.' });
    }
    const { gate, business } = await approvalGate.approveGate(req.params.id);
    res.json({ gate, business });
  })
);

// POST /api/agent/business/gates/:id/reevaluate — refine the requirement + re-score.
router.post(
  '/business/gates/:id/reevaluate',
  asyncHandler(async (req, res) => {
    if (!GATE_ID_PATTERN.test(req.params.id)) return res.status(400).json({ error: 'Invalid gate id.' });
    if (!recordForRequest(req, listApprovalGates(), req.params.id)) {
      return res.status(404).json({ error: 'Approval gate not found.' });
    }
    const body = req.body || {};
    const out = await approvalGate.reevaluateGate(req.params.id, typeof body.input === 'string' ? body.input : '');
    res.json(out);
  })
);

// ---- Conversation threads (agent workspace history) --------------------
// Persisted server-side in the shared store, mirroring jobs/memories. Validation
// (id shape, role allowlist, bounded fields) lives in agent/conversations.js; a
// ConversationError carries its status to the central error handler.

// GET /api/agent/conversations — thread summaries (no messages), newest-first.
router.get('/conversations', (req, res) => {
  const context = requestWorkspaceContext(req);
  res.json({
    conversations: listConversations()
      .filter((conversation) => matchesEventContext(conversation, context))
      .map(conversations.summarizeConversation),
  });
});

// POST /api/agent/conversations — create an empty thread.
router.post('/conversations', (req, res) => {
  const body = req.body || {};
  const title = typeof body.title === 'string' && body.title.trim() ? conversations.normalizeTitle(body.title) : undefined;
  const context = requestWorkspaceContext(req);
  res.status(201).json({ conversation: addConversation({
    ...(title ? { title } : {}),
    ...(context.organizationId ? { orgId: context.organizationId } : {}),
    ...(context.projectId ? { nativeProjectId: context.projectId } : {}),
  }) });
});

// GET /api/agent/conversations/:id — full thread with messages.
router.get('/conversations/:id', (req, res) => {
  if (!CONV_ID_PATTERN.test(String(req.params.id || ''))) return res.status(400).json({ error: 'Invalid conversation id.' });
  const conversation = conversationForRequest(req, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  res.json({ conversation });
});

// POST /api/agent/conversations/:id/messages — append a turn; auto-titles an
// untitled thread from its first user message.
router.post('/conversations/:id/messages', (req, res) => {
  const id = String(req.params.id || '');
  if (!CONV_ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid conversation id.' });
  const existing = conversationForRequest(req, id);
  if (!existing) return res.status(404).json({ error: 'Conversation not found.' });
  const messages = conversations.normalizeMessages(req.body && req.body.messages)
    .map((message) => ({ ...message, text: redactUserText(message.text) }));
  const updated = appendConversationMessages(id, messages);
  const untitled = !existing.title || existing.title === 'New conversation';
  const hadUser = (existing.messages || []).some((message) => message.role === 'user');
  const firstUser = hadUser ? null : messages.find((message) => message.role === 'user');
  const conversation = untitled && firstUser
    ? updateConversation(id, { title: conversations.deriveTitle(firstUser.text) })
    : updated;
  res.json({ conversation });
});

// PATCH /api/agent/conversations/:id — rename.
router.patch('/conversations/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!CONV_ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid conversation id.' });
  if (!conversationForRequest(req, id)) return res.status(404).json({ error: 'Conversation not found.' });
  const conversation = updateConversation(id, { title: conversations.normalizeTitle(req.body && req.body.title) });
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  res.json({ conversation });
});

// DELETE /api/agent/conversations/:id — remove a thread, cascading to its
// attachments first (best-effort — a cleanup failure must never block the
// conversation delete itself, and never orphan an unbounded background job).
router.delete(
  '/conversations/:id',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || '');
    if (!CONV_ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid conversation id.' });
    const existing = conversationForRequest(req, id);
    if (!existing) return res.status(404).json({ error: 'Conversation not found.' });
    if (existing.orgId && existing.nativeProjectId) {
      const context = { organizationId: existing.orgId, projectId: existing.nativeProjectId };
      await attachmentsService
        .removeAllAttachmentsForConversation(
          { orgId: existing.orgId, projectId: existing.nativeProjectId, conversationId: id },
          attachmentDeps(context)
        )
        .catch(() => {});
    }
    if (!removeConversation(id)) return res.status(404).json({ error: 'Conversation not found.' });
    res.json({ ok: true });
  })
);

// Chat attachments (upload/extract/embed/index, retrieval, and the /ask
// endpoint) — a fully self-contained, newly-added surface split into its own
// router file rather than growing this already-large one further.
router.use(require('./agent-attachments'));

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
  const context = requestWorkspaceContext(req);
  let jobs;
  if (!context.organizationId) {
    jobs = clearFinishedJobs();
  } else {
    for (const job of jobsForContext(context)) {
      if (job.status === 'done' || job.status === 'error') removeJob(job.id);
    }
    jobs = jobsForContext(context);
  }
  res.json({ jobs });
});

// DELETE /api/agent/jobs/:id — remove a single job.
router.delete('/jobs/:id', (req, res) => {
  const context = requestWorkspaceContext(req);
  const job = jobsForContext(context).find((candidate) => candidate.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  const removed = removeJob(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Job not found.' });
  res.json({ ok: true });
});

// POST /api/agent/enqueue — queue ONE project for the planner, then kick a
// non-overlapping tick so it starts without waiting for the cadence. Role-gated
// (the same server-side gate as run-now); projectId is bounded and only ever
// passed as a parameterized Linear GraphQL variable, never a path.
router.post(
  '/enqueue',
  requireAssumedRole,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    if (!projectId || projectId.length > 200) return res.status(400).json({ error: 'projectId is required.' });
    const projectName = typeof body.projectName === 'string' ? body.projectName.slice(0, 200) : projectId;
    const context = requestWorkspaceContext(req);
    const orgId = context.organizationId || null;
    if (orgId) {
      const fundInfo = getOrgFundStatus(orgId);
      if (fundInfo && fundInfo.fundsAvailable === false) {
        return res.status(402).json({
          error: fundInfo.reason || 'Organization funds unavailable — scheduled calls and enqueue disabled.',
          code: 'funds_unavailable',
          fundStatus: 'unavailable',
          fundsAvailable: false,
        });
      }
    }
    const job = scheduler.enqueue({
      projectId,
      projectName,
      assumedRole: req.assumedRole,
      orgId,
      nativeProjectId: context.projectId || null,
    });
    // Fire-and-forget tick; the queued job is processed on this (or the next) tick.
    Promise.resolve(scheduler.processPending()).catch(() => {});
    res.json({ job, status: schedulerStatusForContext(context) });
  })
);

// POST /api/agent/run-now — manual scheduler tick (still bounded/non-overlapping).
router.post(
  '/run-now',
  requireAssumedRole,
  asyncHandler(async (req, res) => {
    const context = requestWorkspaceContext(req);
    const orgId = context.organizationId || null;
    if (orgId) {
      const fundInfo = getOrgFundStatus(orgId);
      if (fundInfo && fundInfo.fundsAvailable === false) {
        return res.status(402).json({
          error: fundInfo.reason || 'Organization funds unavailable — scheduled calls disabled.',
          code: 'funds_unavailable',
          fundStatus: 'unavailable',
          fundsAvailable: false,
        });
      }
    }
    const result = await scheduler.processPending();
    res.json({ result, status: schedulerStatusForContext(context) });
  })
);

module.exports = router;
