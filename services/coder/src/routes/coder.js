'use strict';

const express = require('express');
const { getSettings } = require('@ai-fleet/shared/store');
const { asyncHandler } = require('@ai-fleet/shared/util');
const linear = require('@ai-fleet/shared/linear');
const log = require('@ai-fleet/shared/logger');
const { resolveLlm } = require('@ai-fleet/shared/agent/llm');
const { runCoder } = require('@ai-fleet/shared/agent/coder');
const orchestrator = require('@ai-fleet/shared/agent/coder-orchestrator');

/**
 * Code-writer deep agent endpoints:
 *   GET  /api/coder             — monitor status + in-flight tickets
 *   POST /api/coder/run         — run the code-writer on one ticket { issueId }
 *   POST /api/coder/monitor     — start/resume/stop the board monitor { action }
 */

const router = express.Router();

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

// GET /api/coder — status.
router.get('/', (req, res) => res.json(orchestrator.status()));

// POST /api/coder/run — dispatch a single ticket (async; watch server logs / Linear Workpad).
router.post(
  '/run',
  asyncHandler(async (req, res) => {
    const issueId = req.body && String(req.body.issueId || '').trim();
    if (!issueId) return res.status(400).json({ error: 'issueId is required.' });

    const settings = getSettings();
    if (!settings.linearApiKey) return res.status(400).json({ error: 'Add a Linear API key in Settings.' });

    const data = await linear.linearRequest(settings.linearApiKey, ISSUE_QUERY, { id: issueId });
    if (!data || !data.issue) return res.status(404).json({ error: `Issue ${issueId} not found.` });
    const issue = toIssue(data.issue);

    let readiness;
    try {
      readiness = await orchestrator.preflightAndPause(issue, (role) => resolveLlm(settings, role));
    } catch (error) {
      const reason = error && error.pauseReason;
      return res.status(503).json({
        error: reason ? reason.message : 'Agent jobs are paused until the workspace is ready.',
        paused: true,
        pauseReason: reason || null,
      });
    }
    const { llm } = readiness;

    // Long-running; dispatch detached and return accepted. Progress goes to the logs + the Linear Workpad.
    const step = (m) => log.info(`[coder ${issue.identifier}] ${m}`);
    Promise.resolve()
      .then(() => runCoder({ issue, llm, apiKey: settings.linearApiKey, keys: buildKeys(settings), onStep: step }))
      .then((r) => log.info(`[coder ${issue.identifier}] done: ${String(r.finalText || '').slice(0, 160)}`))
      .catch((err) => {
        const reason = orchestrator.pauseForRuntimeError(err, {
          task: issue,
          role: readiness.role,
          repositoryProvider: readiness.selection.provider,
          llm,
        });
        if (reason) {
          log.warn(`[coder ${issue.identifier}] Agent jobs paused: ${reason.message}`);
          return;
        }
        log.error(`[coder ${issue.identifier}] failed: ${err && err.message ? err.message : err}`);
      });

    res.status(202).json({ accepted: true, issue: { id: issue.id, identifier: issue.identifier, state: issue.state }, provider: llm.provider, model: llm.model });
  })
);

// POST /api/coder/monitor — start/resume/stop the board monitor.
router.post('/monitor', (req, res) => {
  const action = req.body && String(req.body.action || '').trim();
  if (action === 'start') return res.json(orchestrator.start());
  if (action === 'resume') return res.json(orchestrator.resume());
  if (action === 'stop') return res.json(orchestrator.stop());
  return res.status(400).json({ error: 'action must be "start", "resume", or "stop".' });
});

module.exports = router;
