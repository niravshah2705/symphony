'use strict';

const { getApiKey, getSettings } = require('@ai-fleet/shared/store');
const linear = require('@ai-fleet/shared/linear');
const log = require('@ai-fleet/shared/logger');
const { resolveLlm } = require('@ai-fleet/shared/agent/llm');
const { runCoder } = require('@ai-fleet/shared/agent/coder');
const {
  fetchOrgEffectivePolicy,
  resolvePolicyOrganization,
  isOrganizationContextMismatch,
  isPolicyUnavailableError,
  PolicyUnavailableError,
} = require('@ai-fleet/shared/agent/org-policy-client');
const {
  enforceLlmModel,
  applyOperationalPrefs,
  isPolicyDeniedError,
} = require('@ai-fleet/shared/agent/policy-runtime');
const orchestrator = require('@ai-fleet/shared/agent/coder-orchestrator');
const { publishEvent } = require('@ai-fleet/shared/messaging/events');
const jobs = require('@ai-fleet/shared/messaging/jobs');
const { billingStatus } = require('@ai-fleet/shared/billing/gate');

/**
 * Shared coder dispatch — the single implementation used by the HTTP route
 * (POST /api/coder/run), the Pub/Sub push handler, and the Cloud Run Job worker.
 *
 * Each coder step is forwarded to the conversation's event stream (SSE) so the
 * UI receives intermittent progress, in addition to the existing logs + Linear
 * Workpad.
 */

const ISSUE_QUERY = `
  query CoderIssue($id: String!) {
    issue(id: $id) {
      id identifier title description url
      state { name }
      labels { nodes { name } }
    }
  }`;

function toIssue(node) {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description,
    url: node.url,
    state: node.state && node.state.name,
    labels: ((node.labels && node.labels.nodes) || []).map((l) => l.name),
  };
}

function buildKeys(s, linearApiKey = getApiKey()) {
  return {
    linearApiKey,
    langsmithApiKey: s.langsmithApiKey,
    langsmithTracing: s.langsmithTracing,
    langsmithProject: s.langsmithProject,
    langsmithEndpoint: s.langsmithEndpoint,
    agentRuntime: s.agentRuntime,
    workflowPattern: s.workflowPattern,
  };
}

function httpError(message, status, extra = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extra);
  return error;
}

async function loadIssue(_settings, issueId, apiKey = getApiKey()) {
  if (!apiKey) throw httpError('Add a Linear API key in Settings.', 400);
  const data = await linear.linearRequest(apiKey, ISSUE_QUERY, { id: issueId });
  if (!data || !data.issue) throw httpError(`Issue ${issueId} not found.`, 404);
  return toIssue(data.issue);
}

function eventContext(organizationId, projectId) {
  return { organizationId: organizationId || null, projectId: projectId || null };
}

function hasEffectivePolicy(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length,
  );
}

/** Emit a coder step to logs + (when present) the scoped conversation SSE stream. */
function makeStep(issue, conversationId, context, publish = publishEvent) {
  return (message) => {
    log.info(`[coder ${issue.identifier}] ${message}`);
    if (conversationId) publish(conversationId, { level: 'info', message, ts: new Date().toISOString() }, context);
  };
}

/**
 * Preflight + run the coder in THIS process. Detached by default (returns a 202-
 * style summary immediately); pass `blocking: true` (the Cloud Run Job worker) to
 * await the full run and return its result.
 */
async function runTicketInProcess({
  issueId,
  conversationId = null,
  blocking = false,
  orgId = null,
  nativeProjectId = null,
  llmGateway = null,
}, dependencies = {}) {
  const getSettingsImpl = dependencies.getSettings || getSettings;
  const getApiKeyImpl = dependencies.getApiKey || getApiKey;
  const loadIssueImpl = dependencies.loadIssue || loadIssue;
  const billingStatusImpl = dependencies.billingStatus || billingStatus;
  const resolvePolicyImpl = dependencies.resolvePolicy || fetchOrgEffectivePolicy;
  const resolveLlmImpl = dependencies.resolveLlm || resolveLlm;
  const preflightImpl = dependencies.preflightAndPause || orchestrator.preflightAndPause;
  const runCoderImpl = dependencies.runCoder || runCoder;
  const publish = dependencies.publishEvent || publishEvent;

  // A dedicated runtime is pinned to one org. Shared runtimes use the org that
  // the gateway/org service already validated. Resolve this before any policy or
  // model work so a conflicting tenant context fails closed.
  const effectiveOrgId = resolvePolicyOrganization(orgId);
  const context = eventContext(effectiveOrgId, nativeProjectId);
  // The per-request LLM gateway flag rides the settings object because
  // resolveLlm reads ONLY settings; unflagged runs keep the store shape as-is.
  const storeSettings = getSettingsImpl();
  const settings = llmGateway ? { ...storeSettings, llmGateway } : storeSettings;
  const apiKey = getApiKeyImpl();
  const loadedIssue = await loadIssueImpl(settings, issueId, apiKey);
  const issue = {
    ...loadedIssue,
    ...(effectiveOrgId ? { orgId: effectiveOrgId } : {}),
    ...(nativeProjectId ? { nativeProjectId } : {}),
  };
  const onStep = makeStep(issue, conversationId, context, publish);

  // Negative-balance gate for on-demand runs: refuse with the same 503 + pauseReason
  // shape the readiness gate uses, so the SPA surfaces it identically.
  const billing = billingStatusImpl({ orgId: effectiveOrgId || undefined });
  if (billing.blocked) {
    throw httpError(billing.reason, 503, {
      paused: true,
      pauseReason: { code: 'billing-unavailable', resource: 'billing', message: billing.reason },
    });
  }

  // Resolve the selected org + native-project cascade before resolving/probing
  // the execution model. A selected organization fails closed when its policy
  // is unavailable; only the empty legacy local context remains allow-all.
  let resolvedPolicy = null;
  try {
    resolvedPolicy = await resolvePolicyImpl(effectiveOrgId || undefined, nativeProjectId || undefined);
  } catch (error) {
    if (isOrganizationContextMismatch(error)) throw error;
    if (effectiveOrgId) {
      throw isPolicyUnavailableError(error)
        ? error
        : new PolicyUnavailableError(undefined, error);
    }
  }
  const effectivePolicy = (resolvedPolicy && resolvedPolicy.effectivePolicy) || null;
  if (effectiveOrgId && !hasEffectivePolicy(effectivePolicy)) {
    throw new PolicyUnavailableError();
  }
  const keys = applyOperationalPrefs(buildKeys(settings, apiKey), (resolvedPolicy && resolvedPolicy.prefs) || {}, onStep);

  let readiness;
  try {
    readiness = await preflightImpl(issue, async (role) => {
      const candidate = await resolveLlmImpl(settings, role);
      const enforced = enforceLlmModel(candidate, effectivePolicy);
      if (candidate && enforced && candidate.model !== enforced.model) {
        onStep(`Model "${candidate.model}" is denied by organization policy; using allowed "${enforced.model}".`);
      }
      return enforced;
    });
  } catch (error) {
    if (
      isPolicyUnavailableError(error)
      || isPolicyDeniedError(error)
      || isOrganizationContextMismatch(error)
    ) throw error;
    const reason = error && error.pauseReason;
    throw httpError(reason ? reason.message : 'Agent jobs are paused until the workspace is ready.', 503, {
      paused: true,
      pauseReason: reason || null,
    });
  }

  const { llm } = readiness;
  const summary = { accepted: true, issue: { id: issue.id, identifier: issue.identifier, state: issue.state }, provider: llm.provider, model: llm.model };

  const run = () => runCoderImpl({
    issue,
    llm,
    apiKey,
    keys,
    onStep,
    settings: {
      effectivePolicy,
      orgId: effectiveOrgId || null,
      nativeProjectId: nativeProjectId || null,
      llmGateway: llmGateway || null,
    },
  });
  const onError = (err) => {
    if (isPolicyUnavailableError(err) || isPolicyDeniedError(err)) {
      const message = err && err.message ? err.message : String(err);
      log.warn(`[coder ${issue.identifier}] blocked by workspace policy: ${message}`);
      if (conversationId) publish(conversationId, { level: 'error', message: `Coder blocked by workspace policy: ${message}`, ts: new Date().toISOString() }, context);
      return;
    }
    const reason = orchestrator.pauseForRuntimeError(err, {
      task: issue,
      role: readiness.role,
      repositoryProvider: readiness.selection.provider,
      llm,
    });
    if (reason) {
      log.warn(`[coder ${issue.identifier}] Agent jobs paused: ${reason.message}`);
      if (conversationId) publish(conversationId, { level: 'warn', message: `Paused: ${reason.message}`, ts: new Date().toISOString() }, context);
      return;
    }
    const message = err && err.message ? err.message : String(err);
    log.error(`[coder ${issue.identifier}] failed: ${message}`);
    if (conversationId) publish(conversationId, { level: 'error', message: `Coder failed: ${message}`, ts: new Date().toISOString() }, context);
  };
  const onDone = (r) => {
    const message = `done: ${String((r && r.finalText) || '').slice(0, 160)}`;
    log.info(`[coder ${issue.identifier}] ${message}`);
    if (conversationId) publish(conversationId, { level: 'info', message, ts: new Date().toISOString() }, context);
  };

  if (blocking) {
    const result = await run().then((r) => { onDone(r); return r; }, (err) => { onError(err); throw err; });
    return { ...summary, result };
  }
  Promise.resolve().then(run).then(onDone).catch(onError);
  return summary;
}

/**
 * Dispatch a coder ticket. In the cloud (isCloudJobEnabled) this hands off to a
 * one-shot Cloud Run Job (long-running, scale-to-zero) and returns immediately;
 * locally it runs in-process (detached).
 */
async function runTicket({ issueId, conversationId = null, orgId = null, nativeProjectId = null, llmGateway = null }, dependencies = {}) {
  const jobsImpl = dependencies.jobs || jobs;
  const getSettingsImpl = dependencies.getSettings || getSettings;
  const getApiKeyImpl = dependencies.getApiKey || getApiKey;
  const loadIssueImpl = dependencies.loadIssue || loadIssue;
  const publish = dependencies.publishEvent || publishEvent;
  const effectiveOrgId = resolvePolicyOrganization(orgId);
  const context = eventContext(effectiveOrgId, nativeProjectId);
  if (jobsImpl.isCloudJobEnabled()) {
    const settings = getSettingsImpl();
    const issue = await loadIssueImpl(settings, issueId, getApiKeyImpl());
    const { execution } = await jobsImpl.runCoderJob({
      issueId: issue.id,
      env: {
        ...(conversationId ? { CONVERSATION_ID: conversationId } : {}),
        ...(effectiveOrgId ? { FLEET_ORG_ID: effectiveOrgId } : {}),
        ...(nativeProjectId ? { AI_FLEET_PROJECT_CONTEXT: nativeProjectId } : {}),
        ...(llmGateway ? { LLM_GATEWAY_FLAG: llmGateway } : {}),
      },
    });
    if (conversationId) {
      publish(conversationId, { level: 'info', message: `Launched coder Job for ${issue.identifier}`, execution, ts: new Date().toISOString() }, context);
    }
    return { accepted: true, issue: { id: issue.id, identifier: issue.identifier, state: issue.state }, execution };
  }
  return runTicketInProcess(
    { issueId, conversationId, blocking: false, orgId: effectiveOrgId, nativeProjectId, llmGateway },
    dependencies,
  );
}

module.exports = { runTicket, runTicketInProcess, loadIssue, buildKeys, toIssue, eventContext, ISSUE_QUERY };
