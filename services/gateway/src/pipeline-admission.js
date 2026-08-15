'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { CONFIG } = require('@ai-fleet/shared-core/config');
const harnessCatalog = require('@ai-fleet/shared-core/agent/harness-catalog.json');
const { repoParts } = require('@ai-fleet/shared-core/agent/repo-url');
const {
  customPresetForSettings,
  presetForModel,
  publicCatalog,
} = require('@ai-fleet/shared-core/agent/model-presets');
const { billingStatus } = require('@ai-fleet/shared-core/billing/gate');
const {
  MAX_STAGE_COMMAND_REQUEST_BYTES,
  MAX_STAGE_RESULT_OUTPUT_BYTES,
  PipelineContractError,
  copySecretFreeJson,
  createPipelineStart,
  createPreflightSnapshot,
  createStageCommandV1,
  normalizeRequestedStages,
} = require('@ai-fleet/shared-core/pipeline/contracts');
const store = require('@ai-fleet/shared-core/store');
const { callJson } = require('./service-client');
const { bearerToken } = require('./auth');
const { requestContext } = require('./request-context');

const ORCHESTRATOR_RUNS_PATH = '/api/v1/pipeline-runs';
const SETTINGS_PREFLIGHT_PATH = '/api/v1/settings/preflight';
const MAX_CANCEL_REASON_CHARS = 500;
// Reserve the rest of the canonical StageCommand budget for the immutable
// preflight snapshot and accumulated prior stage results.
const MAX_PIPELINE_REQUEST_BYTES = MAX_STAGE_COMMAND_REQUEST_BYTES;
const CONTROL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const STAGE_WORKFLOWS = Object.freeze({
  plan: 'planning',
  code: 'coding',
  test: 'testing',
  deploy: 'deployment',
});
const STAGE_HARNESS_PREFS = Object.freeze({
  plan: 'planHarness',
  code: 'codeHarness',
  test: 'testHarness',
  deploy: 'deployHarness',
});
const STAGE_MODEL_ROLES = Object.freeze({
  plan: 'thinking',
  code: 'execution',
  test: 'testing',
  deploy: 'deployment',
});
const POLICY_DOMAINS = Object.freeze(['harness', 'tools', 'skills', 'plugins', 'hooks', 'models']);
const LOCAL_PREF_KEYS = Object.freeze([
  'agentRuntime', 'planHarness', 'codeHarness', 'testHarness', 'deployHarness', 'llmProvider',
]);
const PROVIDER_CREDENTIAL_KINDS = Object.freeze({
  codex: new Set(['codexTokenBundle', 'openaiApiKey']),
  claude: new Set(['anthropicApiKey', 'claudeTokenSet']),
  antigravity: new Set(['geminiApiKey']),
  huggingface: new Set(['huggingfaceApiKey']),
});
// Auth-disabled mode has no remote policy service, but stage workers still
// require a concrete immutable allowlist. Keep this SDK-free list aligned with
// the public settings universe/tool registry; an empty domain means deny-all,
// not the legacy local allow-all behavior.
const LOCAL_POLICY_CATALOG = Object.freeze({
  tools: Object.freeze([
    'docker', 'environments', 'build', 'android', 'security', 'quality',
    'codegen', 'playwright', 'billing',
  ]),
  skills: Object.freeze(['linear', 'software-planning', 'web-research', 'pull', 'commit', 'push', 'land']),
  hooks: Object.freeze(['pre-plan', 'post-plan', 'pre-code', 'post-code', 'pre-pr', 'post-merge']),
});

class PipelineAdmissionError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.name = 'PipelineAdmissionError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function admissionError(message, status, code, details) {
  throw new PipelineAdmissionError(message, status, code, details);
}

function safeServiceError(data, fallback) {
  if (!data || typeof data !== 'object') return fallback;
  if (typeof data.error === 'string' && data.error.trim()) return data.error.slice(0, 1000);
  if (data.error && typeof data.error.message === 'string' && data.error.message.trim()) {
    return data.error.message.slice(0, 1000);
  }
  if (typeof data.detail === 'string' && data.detail.trim()) return data.detail.slice(0, 1000);
  return fallback;
}

function userBearer(req) {
  if (req && req.auth && req.auth.mode === 'disabled') return '';
  return `Bearer ${bearerToken(req)}`;
}

function initiatingUserId(req) {
  const user = req && req.auth && req.auth.user;
  const candidate = user && (user.sub || user.uid);
  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  return req && req.auth && req.auth.mode === 'disabled' ? 'local-operator' : '';
}

function requiredContext(req) {
  const context = requestContext(req);
  if (context.organizationId && context.projectId) return context;
  if (!context.organizationId && !context.projectId && req && req.auth && req.auth.mode === 'disabled') {
    return Object.freeze({ organizationId: 'local-org', projectId: 'local-project', local: true });
  }
  if (!context.organizationId || !context.projectId) {
    admissionError(
      'Select an organization and project before starting pipeline work.',
      403,
      'pipeline_context_required',
    );
  }
  return context;
}

function requestedStages(value) {
  try {
    return normalizeRequestedStages(value);
  } catch (error) {
    if (error instanceof PipelineContractError) {
      admissionError(error.message, 400, error.code || 'invalid_pipeline_contract');
    }
    throw error;
  }
}

function requestHarnesses(body, stages) {
  const raw = body && body.harnesses;
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    admissionError('harnesses must be an object keyed by requested stage.', 400, 'invalid_pipeline_harnesses');
  }
  const requested = new Set(stages);
  const result = {};
  for (const [stage, value] of Object.entries(raw)) {
    if (!requested.has(stage)) {
      admissionError(`harnesses contains unrequested stage "${stage}".`, 400, 'invalid_pipeline_harnesses');
    }
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) {
      admissionError(`harnesses.${stage} is invalid.`, 400, 'invalid_pipeline_harnesses');
    }
    result[stage] = value.trim().toLowerCase();
  }
  return result;
}

function boundedSecretFreeRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    admissionError('request must be a JSON object.', 400, 'invalid_pipeline_contract');
  }
  let requestBytes;
  try {
    requestBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (_) {
    admissionError('request must be JSON-compatible.', 400, 'invalid_pipeline_contract');
  }
  if (requestBytes > MAX_PIPELINE_REQUEST_BYTES) {
    admissionError(
      `request must be at most ${MAX_PIPELINE_REQUEST_BYTES} bytes.`,
      413,
      'pipeline_request_too_large',
    );
  }
  try {
    const copied = copySecretFreeJson(value, 'request');
    return copied;
  } catch (error) {
    if (error instanceof PipelineAdmissionError) throw error;
    if (error instanceof PipelineContractError) {
      admissionError(error.message, 400, error.code || 'invalid_pipeline_contract');
    }
    throw error;
  }
}

function pipelineRequest(body) {
  return boundedSecretFreeRequest(body && body.request !== undefined ? body.request : {});
}

function decisionStages(decision) {
  return decision && Array.isArray(decision.stages) ? decision.stages : [];
}

function stageModelSelections(stages, settings = {}) {
  return Object.fromEntries(stages.map((stage) => {
    const role = STAGE_MODEL_ROLES[stage];
    const provider = String(settings[`${role}LlmProvider`] || settings.llmProvider || 'ollama')
      .trim()
      .toLowerCase();
    const descriptor = customPresetForSettings(provider, settings);
    const model = descriptor && typeof descriptor.model === 'string' ? descriptor.model.trim() : '';
    const preset = model ? presetForModel(provider, model) : null;
    if (!provider || !model) {
      admissionError(`The ${stage} model selection is incomplete.`, 409, 'pipeline_model_not_configured');
    }
    return [stage, Object.freeze({ provider, model, modelId: preset ? preset.id : 'custom' })];
  }));
}

function normalizeEffectivePolicy(domains) {
  if (!domains || typeof domains !== 'object' || Array.isArray(domains)) {
    admissionError('Settings preflight omitted the effective user policy.', 503, 'pipeline_preflight_invalid');
  }
  const result = {};
  for (const domain of POLICY_DOMAINS) {
    const values = domains[domain];
    if (!Array.isArray(values) || values.length > 1_000 || values.some((value) => (
      typeof value !== 'string' || !value.trim() || value.length > 200
    ))) {
      admissionError('Settings preflight returned an invalid effective user policy.', 503, 'pipeline_preflight_invalid');
    }
    result[domain] = { effective: [...new Set(values.map((value) => value.trim()))] };
  }
  return result;
}

function validatePreflightDecision(decision, stages, context, selections) {
  if (!decision || typeof decision !== 'object') {
    admissionError('Settings preflight returned an invalid decision.', 503, 'pipeline_preflight_unavailable');
  }
  const decisions = decisionStages(decision);
  const exactStages = decisions.length === stages.length
    && decisions.every((item, index) => item && item.stage === stages[index]);
  const selectedProject = decision.project_id || decision.projectId || null;
  if (!exactStages || (selectedProject && String(selectedProject) !== context.projectId)) {
    admissionError('Settings preflight returned a decision for a different pipeline scope.', 503, 'pipeline_preflight_invalid');
  }
  const decisionId = typeof decision.decision_id === 'string' ? decision.decision_id : '';
  const invalidStageShape = decisions.some((item) => (
    item.workflow !== STAGE_WORKFLOWS[item.stage]
    || typeof item.harness !== 'string'
    || !item.harness.trim()
    || item.harness.length > 100
    || (item.provider !== null && item.provider !== undefined && (
      typeof item.provider !== 'string' || !item.provider.trim() || item.provider.length > 100
    ))
    || typeof item.model !== 'string'
    || !item.model.trim()
    || item.model.length > 100
    || !selections[item.stage]
    || item.provider !== selections[item.stage].provider
    || item.model !== selections[item.stage].modelId
    || (item.credential && item.credential.source !== null && item.credential.source !== undefined && (
      typeof item.credential.source !== 'string' || item.credential.source.length > 100
    ))
    || (PROVIDER_CREDENTIAL_KINDS[item.provider] && item.credential && item.credential.ready === true && (
      !item.credential
      || typeof item.credential.kind !== 'string'
      || !PROVIDER_CREDENTIAL_KINDS[item.provider].has(item.credential.kind)
    ))
  ));
  if (!CONTROL_ID_RE.test(decisionId) || invalidStageShape) {
    admissionError('Settings preflight returned an invalid decision.', 503, 'pipeline_preflight_invalid');
  }
  const denied = decisions.filter((item) => (
    item.allowed !== true
    || item.available !== true
    || item.supported !== true
    || item.brokered !== true
    || !item.credential
    || item.credential.ready !== true
    || (Array.isArray(item.errors) && item.errors.length > 0)
  ));
  if (decision.ready !== true || denied.length > 0) {
    admissionError(
      'Pipeline preflight did not approve every requested stage.',
      409,
      'pipeline_preflight_not_ready',
      {
        decisionId,
        stages: denied.map((item) => ({
          stage: item && item.stage || null,
          errors: Array.isArray(item && item.errors) ? item.errors : ['stage_not_ready'],
        })),
      },
    );
  }
  const normalized = {
    schemaVersion: 1,
    decisionId,
    ready: true,
    projectId: selectedProject ? String(selectedProject) : null,
    prefs: decision.prefs && typeof decision.prefs === 'object' && !Array.isArray(decision.prefs)
      ? decision.prefs
      : {},
    locks: Array.isArray(decision.locks) ? decision.locks : [],
    effectivePolicy: normalizeEffectivePolicy(decision.domains),
    stages: decisions.map((item) => ({
      stage: item.stage,
      workflow: item.workflow,
      harness: item.harness.trim(),
      provider: typeof item.provider === 'string' ? item.provider.trim() : null,
      modelId: item.model.trim(),
      allowed: item.allowed === true,
      available: item.available === true,
      supported: item.supported === true,
      brokered: item.brokered === true,
      providerReady: item.credential && item.credential.ready === true,
      providerSource: item.credential && typeof item.credential.source === 'string'
        ? item.credential.source
        : null,
      providerAuthKind: item.credential && typeof item.credential.kind === 'string'
        ? item.credential.kind
        : null,
      errors: [],
    })),
  };
  try {
    return copySecretFreeJson(normalized, 'settingsPreflight');
  } catch (_) {
    admissionError('Settings preflight returned forbidden credential material.', 503, 'pipeline_preflight_invalid');
  }
}

function deploymentConfiguration(request) {
  const raw = request && request.deployment;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    admissionError(
      'request.deployment.environment is required when deploy is requested.',
      400,
      'pipeline_deployment_environment_required',
    );
  }
  const environment = typeof raw.environment === 'string' ? raw.environment.trim().toLowerCase() : '';
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(environment)) {
    admissionError(
      'request.deployment.environment is invalid.',
      400,
      'pipeline_deployment_environment_invalid',
    );
  }
  return { enabled: true, environment };
}

function stageConfigurationFromDecision(decision, stages, selections, request) {
  const byStage = new Map(decisionStages(decision).map((item) => [item.stage, item]));
  return Object.fromEntries(stages.map((stage) => {
    const item = byStage.get(stage) || {};
    return [stage, {
      harness: item.harness,
      provider: item.provider || null,
      model: selections[stage].model,
      modelId: item.modelId,
      providerReady: item.providerReady === true,
      brokered: item.brokered === true,
      ...(stage === 'deploy' ? deploymentConfiguration(request) : {}),
    }];
  }));
}

/** The shared proxy has no trustworthy per-request organization selector and
 * therefore can resolve only platform-managed credentials. Customer-selected
 * credentials are admitted only by a deployment pinned to the same org via
 * FLEET_ORG_ID (CONFIG.BILLING.orgId); the per-tenant proxy carries the matching
 * PROXY_ORG_ID and resolves that org's vault. */
function assertCredentialRouting(decision, context, pinnedOrganizationId) {
  const customerStages = decisionStages(decision)
    .filter((stage) => stage && stage.providerSource === 'customer')
    .map((stage) => stage.stage);
  if (customerStages.length === 0) return;
  const pinned = String(pinnedOrganizationId || '').trim();
  if (!pinned || pinned !== context.organizationId) {
    admissionError(
      'Customer-managed provider credentials require the organization\'s dedicated agent deployment.',
      409,
      'pipeline_customer_credential_requires_dedicated_stack',
      { stages: customerStages },
    );
  }
}

/** Codex's ChatGPT backend accepts only an org-scoped OAuth token bundle; an
 * OpenAI API key is valid only on the metered API backend. The credential kind
 * is selected by settings preflight and contains no secret material. */
function assertCredentialBackend(decision, codexBackend = CONFIG.OAUTH && CONFIG.OAUTH.backend) {
  const incompatible = decisionStages(decision).filter((stage) => (
    stage
    && stage.provider === 'codex'
    && String(codexBackend || 'chatgpt').toLowerCase() !== 'api'
    && stage.providerAuthKind !== 'codexTokenBundle'
  ));
  if (incompatible.length > 0) {
    admissionError(
      'The selected Codex credential cannot authenticate the configured ChatGPT backend. Import an organization Codex token bundle or use CODEX_BACKEND=api with an OpenAI API key.',
      409,
      'pipeline_provider_credential_backend_mismatch',
      { stages: incompatible.map((stage) => stage.stage) },
    );
  }
}

/**
 * Resolve repository identity from the trusted workspace store. A repository in
 * the browser payload is deliberately ignored: the immutable pipeline snapshot
 * must describe the repository selected by the server for this workspace.
 */
function localRepositorySnapshot(request, stages, {
  getBusinessByProjectId = store.getBusinessByProjectId,
  getRepositoryConfig = store.getRepositoryConfig,
  configuredRepositoryUrl = CONFIG.CODER && CONFIG.CODER.repoUrl,
} = {}) {
  const externalProjectId = String(
    request.projectId
    || (request.workItem && request.workItem.projectId)
    || '',
  ).trim();
  const business = externalProjectId ? getBusinessByProjectId(externalProjectId) : null;
  const configured = getRepositoryConfig() || {};
  const businessReference = String(business && business.repo || '').trim();
  const provider = String(
    businessReference
      ? business.repoProvider || 'github'
      : configured.provider || 'github',
  ).trim().toLowerCase();
  const reference = businessReference
    || String(configured.url || configuredRepositoryUrl || '').trim();
  const repositoryRequired = stages.some((stage) => stage !== 'plan');

  if (!reference) {
    if (!repositoryRequired) return {};
    admissionError(
      'Configure a repository for this workspace before starting code, test, or deploy.',
      409,
      'pipeline_repository_not_configured',
    );
  }
  if (provider !== 'github') {
    admissionError(
      'The durable code, test, and deploy pipeline currently supports only brokered GitHub repositories.',
      409,
      'pipeline_repository_provider_not_brokered',
    );
  }
  const parts = repoParts(reference, provider);
  if (!parts) {
    admissionError(
      'The configured repository identity is invalid.',
      409,
      'pipeline_repository_invalid',
    );
  }
  return {
    provider: parts.provider,
    owner: parts.owner,
    name: parts.name,
    fullName: parts.fullName,
    url: parts.https,
  };
}

function localProviderReadiness(provider, settings) {
  const tokenReady = (tokens) => Boolean(tokens && (tokens.accessToken || tokens.refreshToken));
  const readiness = provider === 'codex'
    ? { ready: tokenReady(settings.codexTokens), kind: 'codexTokenBundle' }
    : provider === 'claude'
      ? { ready: tokenReady(settings.claudeTokens), kind: 'claudeTokenSet' }
      : provider === 'antigravity'
        ? { ready: Boolean(settings.antigravityApiKey), kind: 'geminiApiKey' }
        : provider === 'huggingface'
          ? { ready: Boolean(settings.huggingfaceApiKey), kind: 'huggingfaceApiKey' }
          : { ready: true, kind: null };
  return {
    ready: readiness.ready,
    source: readiness.ready && readiness.kind ? 'local-effective-store' : null,
    kind: readiness.ready ? readiness.kind : null,
  };
}

/** SDK-free auth-disabled preflight using only the canonical catalog + local store. */
function localPreflightDecision(stages, harnesses, selections = {}, options = {}) {
  // Preserve the public helper's former `(stages, harnesses, options)` test and
  // local-call shape while letting admission pass an already snapshotted model
  // decision as the third argument.
  if (selections && selections.settings && !selections.plan && !selections.code) {
    options = selections;
    selections = {};
  }
  const settings = options.settings || store.getSettings();
  const catalog = options.catalog || harnessCatalog;
  if (stages.some((stage) => !selections[stage])) {
    selections = stageModelSelections(stages, settings);
  }
  const definitions = new Map(
    (catalog && Array.isArray(catalog.harnesses) ? catalog.harnesses : [])
      .map((definition) => [definition.id, definition]),
  );
  const prefs = Object.fromEntries(
    LOCAL_PREF_KEYS
      .filter((key) => typeof settings[key] === 'string' && settings[key].trim())
      .map((key) => [key, settings[key].trim()]),
  );
  const decisions = stages.map((stage) => {
    const workflow = STAGE_WORKFLOWS[stage];
    const selected = String(
      harnesses[stage]
      || prefs[STAGE_HARNESS_PREFS[stage]]
      || prefs.agentRuntime
      || 'deepagent',
    ).trim().toLowerCase();
    const definition = definitions.get(selected);
    const available = Boolean(definition && definition.availability === 'available');
    const allowed = available;
    const supported = Boolean(definition && Array.isArray(definition.stages) && definition.stages.includes(workflow));
    const brokerRequired = workflow === 'coding' || workflow === 'deployment';
    const brokered = Boolean(definition && (
      !brokerRequired
      || (Array.isArray(definition.brokeredStages) && definition.brokeredStages.includes(workflow))
    ));
    const selection = selections[stage];
    const provider = selection && selection.provider;
    const providerReadiness = localProviderReadiness(provider, settings);
    const errors = [];
    if (!definition) errors.push('unknown_harness');
    else if (!available) errors.push('harness_unavailable');
    if (!allowed) errors.push('harness_denied');
    if (definition && !supported) errors.push('stage_unsupported');
    if (definition && !brokered) errors.push('brokered_stage_unsupported');
    if (definition && definition.requiresProvider && definition.requiresProvider !== provider) {
      errors.push('harness_provider_mismatch');
    }
    if (!providerReadiness.ready) errors.push('provider_credential_unavailable');
    return {
      stage,
      workflow,
      harness: selected,
      provider,
      model: selection && selection.modelId,
      allowed,
      available,
      supported,
      brokered,
      credential: providerReadiness,
      errors,
    };
  });
  const material = {
    schema_version: 1,
    project_id: null,
    prefs,
    locks: [],
    // Local/auth-disabled mode intentionally has no remote policy. Represent
    // its established allow-all behavior as the concrete local catalogs.
    domains: {
      harness: [...definitions.values()].filter((item) => item.availability === 'available').map((item) => item.id),
      tools: [...LOCAL_POLICY_CATALOG.tools],
      skills: [...LOCAL_POLICY_CATALOG.skills],
      plugins: [],
      hooks: [...LOCAL_POLICY_CATALOG.hooks],
      models: publicCatalog().presets.map((preset) => preset.id),
    },
    stages: decisions,
  };
  return {
    ...material,
    decision_id: createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 24),
    ready: decisions.every((decision) => decision.errors.length === 0),
  };
}

function statusFromService(status) {
  if ([400, 403, 404, 409].includes(status)) return status;
  return 502;
}

function acceptedDispatch(data, expectedRunId, fallbackConversationId) {
  const run = data && data.run && typeof data.run === 'object' ? data.run : null;
  const stages = data && data.stages;
  const invalidStageId = Array.isArray(stages) && stages.some((stage) => (
    !stage
    || typeof stage !== 'object'
    || typeof stage.commandId !== 'string'
    || stage.commandId.length > 200
    || !stage.commandId.startsWith(`${expectedRunId}:`)
  ));
  if (!run || run.runId !== expectedRunId || !Array.isArray(stages) || invalidStageId) {
    admissionError(
      'Pipeline orchestrator returned an invalid acknowledgement.',
      502,
      'pipeline_dispatch_invalid_response',
    );
  }
  const conversationId = String(fallbackConversationId || expectedRunId);
  return {
    run,
    runId: expectedRunId,
    conversationId,
    stageIds: stages.map((stage) => stage.commandId),
  };
}

function maximumPriorOutput() {
  const framingBytes = Buffer.byteLength(JSON.stringify({ padding: '' }), 'utf8');
  return { padding: 'x'.repeat(MAX_STAGE_RESULT_OUTPUT_BYTES - framingBytes) };
}

function maximumPriorResult(start, stage) {
  return {
    stage,
    attempt: 1,
    status: 'succeeded',
    commandId: `${start.runId}:${stage}:1`,
    artifact: { commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) },
    output: maximumPriorOutput(),
  };
}

/** Prove at gateway admission that every requested command still fits after
 * base64-safe transport budgeting and the maximum bounded prior result outputs.
 * This mirrors SnapshotPreflight + controller command construction without
 * dispatching or trusting later stages to truncate state. */
function assertStageCommandTransportBudget(start) {
  const request = start.request || {};
  const stageConfiguration = { ...(request.stageConfiguration || {}) };
  if (start.requestedStages.includes('deploy')) {
    stageConfiguration.deploy = { ...(stageConfiguration.deploy || {}), approval: null };
  }
  try {
    const preflight = createPreflightSnapshot({
      runId: start.runId,
      organizationId: start.organizationId,
      projectId: start.projectId,
      requestedStages: start.requestedStages,
      repository: request.repository || {},
      workItem: request.workItem || {},
      stageConfiguration,
      policy: request.policy || {},
      capturedAt: start.createdAt,
      metadata: { correlationId: start.correlationId, source: 'pipeline-start' },
    });
    for (const [index, stage] of start.requestedStages.entries()) {
      createStageCommandV1({
        runId: start.runId,
        organizationId: start.organizationId,
        projectId: start.projectId,
        requestedStages: start.requestedStages,
        preflight,
        stage,
        attempt: 1,
        input: {
          request,
          priorResults: start.requestedStages
            .slice(0, index)
            .map((priorStage) => maximumPriorResult(start, priorStage)),
          ...(stage === 'deploy' ? {
            deploymentApproval: {
              approved: true,
              approvalId: 'a'.repeat(160),
              by: 'b'.repeat(320),
              at: start.createdAt,
              source: 'server',
              testCommandId: `${start.runId}:test:1`,
              commitSha: 'a'.repeat(40),
              treeSha: 'b'.repeat(40),
              preflightDecisionDigest: preflight.preflightDecisionDigest,
              deployCommandId: `${start.runId}:deploy:1`,
            },
          } : {}),
        },
        issuedAt: start.createdAt,
        trace: { correlationId: start.correlationId, checkpointRevision: 999999 },
      });
    }
  } catch (error) {
    if (error instanceof PipelineContractError && /StageCommandV1 must be at most/.test(error.message)) {
      admissionError(
        'The admitted pipeline snapshot cannot fit the StageCommand transport budget.',
        413,
        'pipeline_stage_command_too_large',
      );
    }
    throw error;
  }
}

function createPipelineAdmission({
  serviceCall = callJson,
  getBillingStatus = billingStatus,
  addConversation = store.addConversation,
  idFactory = randomUUID,
  clock = () => new Date().toISOString(),
  settingsUrl = CONFIG.SERVICES.settingsUrl,
  orchestratorUrl = CONFIG.SERVICES.orchestratorUrl,
  orchestratorEnabled = CONFIG.PIPELINE && CONFIG.PIPELINE.orchestratorEnabled === true,
  deploymentEnabled = CONFIG.PIPELINE && CONFIG.PIPELINE.deploymentEnabled === true,
  resolveLocalPreflight = localPreflightDecision,
  getSettings = store.getSettings,
  resolveRepository = localRepositorySnapshot,
  pinnedOrganizationId = CONFIG.BILLING && CONFIG.BILLING.orgId,
  internalApiToken = process.env.INTERNAL_API_TOKEN || '',
} = {}) {
  function assertOrchestratorEnabled() {
    if (!orchestratorEnabled) {
      admissionError(
        'The durable pipeline orchestrator is disabled for this environment.',
        503,
        'pipeline_orchestrator_disabled',
      );
    }
  }

  async function preflight(req, stages, context, harnesses, selections) {
    if (req && req.auth && req.auth.mode === 'disabled') {
      return validatePreflightDecision(
        await Promise.resolve(resolveLocalPreflight(stages, harnesses, selections, { settings: getSettings() })),
        stages,
        context,
        selections,
      );
    }
    if (!settingsUrl) {
      admissionError('Settings preflight service is not configured.', 503, 'pipeline_preflight_unavailable');
    }
    let response;
    try {
      response = await serviceCall(settingsUrl, SETTINGS_PREFLIGHT_PATH, {
        method: 'POST',
        body: {
          ...(context.local ? {} : { project_id: context.projectId }),
          stages,
          harnesses,
          providers: Object.fromEntries(stages.map((stage) => [stage, selections[stage].provider])),
          models: Object.fromEntries(stages.map((stage) => [stage, selections[stage].modelId])),
        },
        userAuth: userBearer(req),
        context: context.local ? {} : context,
      });
    } catch (_) {
      admissionError('Settings preflight is temporarily unavailable.', 503, 'pipeline_preflight_unavailable');
    }
    if (!response || response.status !== 200) {
      const status = response && [401, 403, 404, 422].includes(response.status) ? response.status : 503;
      admissionError(
        safeServiceError(response && response.data, 'Settings preflight is temporarily unavailable.'),
        status === 422 ? 400 : status,
        status === 503 ? 'pipeline_preflight_unavailable' : 'pipeline_preflight_rejected',
      );
    }
    return validatePreflightDecision(response.data, stages, context, selections);
  }

  async function submit(req, { stages: fixedStages, adaptRequest, title } = {}) {
    assertOrchestratorEnabled();
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const stages = requestedStages(fixedStages || body.requestedStages);
    if (stages.includes('deploy') && !deploymentEnabled) {
      admissionError(
        'Deployment is disabled for this environment.',
        403,
        'pipeline_deployment_disabled',
      );
    }
    const harnesses = requestHarnesses(body, stages);
    const selections = stageModelSelections(stages, getSettings());
    const baseRequest = adaptRequest
      ? boundedSecretFreeRequest(adaptRequest(body))
      : pipelineRequest(body);
    const context = requiredContext(req);
    const requestedBy = initiatingUserId(req);
    if (!requestedBy) admissionError('An initiating user identity is required.', 401, 'authentication_required');
    const repository = await Promise.resolve(resolveRepository(baseRequest, stages));

    const billing = await Promise.resolve(getBillingStatus({
      orgId: context.organizationId,
      projectId: context.projectId,
    }));
    if (billing && billing.blocked) {
      admissionError(
        billing.reason || 'Billing balance is exhausted.',
        402,
        'billing_blocked',
        { orgId: billing.orgId || context.organizationId, balancePaise: billing.balancePaise ?? null },
      );
    }

    const decision = await preflight(req, stages, context, harnesses, selections);
    assertCredentialRouting(decision, context, pinnedOrganizationId);
    assertCredentialBackend(decision);
    const trustedRequest = stages.includes('deploy')
      ? {
        ...baseRequest,
        // Approval and every other deploy control are server-owned. Persist
        // only the validated target environment from browser input.
        deployment: { environment: deploymentConfiguration(baseRequest).environment },
      }
      : baseRequest;
    const runId = idFactory();
    const conversation = addConversation({
      title: typeof title === 'function' ? title(body) : 'Pipeline run',
      orgId: context.organizationId,
      nativeProjectId: context.projectId,
    });
    const conversationId = String(conversation && conversation.id || runId);
    let start;
    try {
      start = createPipelineStart({
        runId,
        organizationId: context.organizationId,
        projectId: context.projectId,
        requestedStages: stages,
        requestedBy,
        correlationId: conversationId,
        request: {
          ...trustedRequest,
          // Replace (never merge) caller input with the server-resolved,
          // tokenless repository identity captured for every later stage.
          repository,
          conversationId,
          // Per-request LLM gateway feature flag (already availability-gated
          // and allowlisted at ingestion by requestContext).
          llmGateway: context.llmGateway || null,
          policy: decision,
          stageConfiguration: stageConfigurationFromDecision(decision, stages, selections, baseRequest),
        },
        metadata: {
          conversationId,
          initiatingUserId: requestedBy,
          preflightDecisionId: decision.decisionId || null,
        },
      }, { clock, idFactory });
    } catch (error) {
      if (error instanceof PipelineContractError) {
        admissionError(error.message, 400, error.code || 'invalid_pipeline_contract');
      }
      throw error;
    }
    assertStageCommandTransportBudget(start);

    if (!orchestratorUrl) {
      admissionError('Pipeline orchestrator is not configured.', 503, 'pipeline_orchestrator_unavailable');
    }
    let response;
    try {
      response = await serviceCall(orchestratorUrl, ORCHESTRATOR_RUNS_PATH, {
        method: 'POST',
        body: start,
        context,
        internalToken: internalApiToken,
      });
    } catch (_) {
      admissionError('Pipeline orchestrator is temporarily unavailable.', 502, 'pipeline_orchestrator_unavailable');
    }
    if (!response || response.status !== 202) {
      admissionError(
        safeServiceError(response && response.data, 'Pipeline orchestrator rejected the run.'),
        statusFromService(response && response.status),
        response && response.data && response.data.code || 'pipeline_dispatch_failed',
      );
    }
    const dispatched = acceptedDispatch(response.data, runId, conversationId);
    return {
      accepted: true,
      runId: dispatched.runId,
      conversationId: dispatched.conversationId,
      stageIds: dispatched.stageIds,
      requestedStages: stages,
      status: dispatched.run.status || 'accepted',
    };
  }

  async function status(req, runId) {
    assertOrchestratorEnabled();
    const context = requiredContext(req);
    let response;
    try {
      response = await serviceCall(orchestratorUrl, `${ORCHESTRATOR_RUNS_PATH}/${encodeURIComponent(runId)}`, {
        context,
        internalToken: internalApiToken,
      });
    } catch (_) {
      admissionError('Pipeline orchestrator is temporarily unavailable.', 502, 'pipeline_orchestrator_unavailable');
    }
    if (!response || response.status !== 200) {
      admissionError(
        safeServiceError(response && response.data, 'Pipeline run could not be loaded.'),
        statusFromService(response && response.status),
        response && response.data && response.data.code || 'pipeline_status_failed',
      );
    }
    return response.data;
  }

  async function cancel(req, runId) {
    assertOrchestratorEnabled();
    const context = requiredContext(req);
    const requestedBy = initiatingUserId(req);
    const rawReason = req.body && req.body.reason;
    const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
    if (reason.length > MAX_CANCEL_REASON_CHARS) {
      admissionError(`reason must be at most ${MAX_CANCEL_REASON_CHARS} characters.`, 400, 'invalid_pipeline_cancel');
    }
    let response;
    try {
      response = await serviceCall(orchestratorUrl, `${ORCHESTRATOR_RUNS_PATH}/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
        body: { requestedBy: requestedBy || null, reason: reason || null },
        context,
        internalToken: internalApiToken,
      });
    } catch (_) {
      admissionError('Pipeline orchestrator is temporarily unavailable.', 502, 'pipeline_orchestrator_unavailable');
    }
    if (!response || response.status !== 200) {
      admissionError(
        safeServiceError(response && response.data, 'Pipeline run could not be cancelled.'),
        statusFromService(response && response.status),
        response && response.data && response.data.code || 'pipeline_cancel_failed',
      );
    }
    return response.data;
  }

  async function resume(req, runId) {
    assertOrchestratorEnabled();
    const context = requiredContext(req);
    let response;
    try {
      response = await serviceCall(orchestratorUrl, `${ORCHESTRATOR_RUNS_PATH}/${encodeURIComponent(runId)}/resume`, {
        method: 'POST',
        body: { retryFailed: req.body && req.body.retryFailed === true },
        context,
        internalToken: internalApiToken,
      });
    } catch (_) {
      admissionError('Pipeline orchestrator is temporarily unavailable.', 502, 'pipeline_orchestrator_unavailable');
    }
    if (!response || response.status !== 200) {
      admissionError(
        safeServiceError(response && response.data, 'Pipeline run could not be resumed.'),
        statusFromService(response && response.status),
        response && response.data && response.data.code || 'pipeline_resume_failed',
      );
    }
    return response.data;
  }

  return { submit, status, cancel, resume };
}

module.exports = {
  MAX_PIPELINE_REQUEST_BYTES,
  ORCHESTRATOR_RUNS_PATH,
  SETTINGS_PREFLIGHT_PATH,
  PipelineAdmissionError,
  assertCredentialRouting,
  assertCredentialBackend,
  assertStageCommandTransportBudget,
  createPipelineAdmission,
  localPreflightDecision,
  localRepositorySnapshot,
  requestedStages,
  stageModelSelections,
  validatePreflightDecision,
};
