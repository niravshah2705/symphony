'use strict';

const { getSettings } = require('@ai-fleet/shared/store');
const linear = require('@ai-fleet/shared/linear');
const log = require('@ai-fleet/shared/logger');
const { resolveLlm } = require('@ai-fleet/shared/agent/llm');
const { runCoder } = require('@ai-fleet/shared/agent/coder');
const orchestrator = require('@ai-fleet/shared/agent/coder-orchestrator');
const { publishEvent } = require('@ai-fleet/shared/messaging/events');
const jobs = require('@ai-fleet/shared/messaging/jobs');

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

function buildKeys(s) {
  return {
    linearApiKey: s.linearApiKey,
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

async function loadIssue(settings, issueId) {
  if (!settings.linearApiKey) throw httpError('Add a Linear API key in Settings.', 400);
  const data = await linear.linearRequest(settings.linearApiKey, ISSUE_QUERY, { id: issueId });
  if (!data || !data.issue) throw httpError(`Issue ${issueId} not found.`, 404);
  return toIssue(data.issue);
}

/** Emit a coder step to logs + (when present) the conversation SSE stream. */
function makeStep(issue, conversationId) {
  return (message) => {
    log.info(`[coder ${issue.identifier}] ${message}`);
    if (conversationId) publishEvent(conversationId, { level: 'info', message, ts: new Date().toISOString() });
  };
}

/**
 * Preflight + run the coder in THIS process. Detached by default (returns a 202-
 * style summary immediately); pass `blocking: true` (the Cloud Run Job worker) to
 * await the full run and return its result.
 */
async function runTicketInProcess({ issueId, conversationId = null, blocking = false }) {
  const settings = getSettings();
  const issue = await loadIssue(settings, issueId);

  let readiness;
  try {
    readiness = await orchestrator.preflightAndPause(issue, (role) => resolveLlm(settings, role));
  } catch (error) {
    const reason = error && error.pauseReason;
    throw httpError(reason ? reason.message : 'Agent jobs are paused until the workspace is ready.', 503, {
      paused: true,
      pauseReason: reason || null,
    });
  }

  const { llm } = readiness;
  const onStep = makeStep(issue, conversationId);
  const summary = { accepted: true, issue: { id: issue.id, identifier: issue.identifier, state: issue.state }, provider: llm.provider, model: llm.model };

  const run = () => runCoder({ issue, llm, apiKey: settings.linearApiKey, keys: buildKeys(settings), onStep });
  const onError = (err) => {
    const reason = orchestrator.pauseForRuntimeError(err, {
      task: issue,
      role: readiness.role,
      repositoryProvider: readiness.selection.provider,
      llm,
    });
    if (reason) {
      log.warn(`[coder ${issue.identifier}] Agent jobs paused: ${reason.message}`);
      if (conversationId) publishEvent(conversationId, { level: 'warn', message: `Paused: ${reason.message}`, ts: new Date().toISOString() });
      return;
    }
    const message = err && err.message ? err.message : String(err);
    log.error(`[coder ${issue.identifier}] failed: ${message}`);
    if (conversationId) publishEvent(conversationId, { level: 'error', message: `Coder failed: ${message}`, ts: new Date().toISOString() });
  };
  const onDone = (r) => {
    const message = `done: ${String((r && r.finalText) || '').slice(0, 160)}`;
    log.info(`[coder ${issue.identifier}] ${message}`);
    if (conversationId) publishEvent(conversationId, { level: 'info', message, ts: new Date().toISOString() });
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
async function runTicket({ issueId, conversationId = null }) {
  if (jobs.isCloudJobEnabled()) {
    const settings = getSettings();
    const issue = await loadIssue(settings, issueId);
    const { execution } = await jobs.runCoderJob({
      issueId: issue.id,
      env: conversationId ? { CONVERSATION_ID: conversationId } : {},
    });
    if (conversationId) {
      publishEvent(conversationId, { level: 'info', message: `Launched coder Job for ${issue.identifier}`, execution, ts: new Date().toISOString() });
    }
    return { accepted: true, issue: { id: issue.id, identifier: issue.identifier, state: issue.state }, execution };
  }
  return runTicketInProcess({ issueId, conversationId, blocking: false });
}

module.exports = { runTicket, runTicketInProcess, loadIssue, buildKeys, toIssue, ISSUE_QUERY };
