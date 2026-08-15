'use strict';

const express = require('express');
const { decodePushMessage } = require('@ai-fleet/shared/messaging/publisher');
const { publishEvent } = require('@ai-fleet/shared/messaging/events');
const { pushAuth } = require('@ai-fleet/shared/messaging/oidc');
const log = require('@ai-fleet/shared/logger');
const orchestrator = require('@ai-fleet/shared/agent/coder-orchestrator');
const { runTicket } = require('./run-ticket');
const { CONFIG } = require('@ai-fleet/shared/config');
const store = require('@ai-fleet/shared/store');
const {
  normalizeWorkspaceContext,
  runWithWorkspaceContext,
  currentWorkspaceContext,
} = require('@ai-fleet/shared/store/workspace-context');

/**
 * Coder-control Pub/Sub push surface:
 *   POST /pubsub/coder       — on-demand coder request { issueId, conversationId }
 *   POST /pubsub/coder-tick  — Cloud Scheduler board-poll tick
 *
 * Long coder work is NOT done in the request (it exceeds the push ack deadline):
 * runTicket launches a Cloud Run Job in the cloud, or runs detached locally, and
 * we ack immediately. Streamed progress reaches the UI via the conversation SSE.
 */

const router = express.Router();

function messageWorkspaceContext(message = {}) {
  return normalizeWorkspaceContext(messageWorkspaceContextInput(message));
}

function messageWorkspaceContextInput(message = {}) {
  return {
    organizationId: message.organizationId || message.orgId,
    projectId: message.nativeProjectId,
  };
}

function runMessageInWorkspace(message, task) {
  return runWithWorkspaceContext(messageWorkspaceContextInput(message), async () => {
    await store.initStore();
    return task(currentWorkspaceContext());
  });
}

function shouldRunAutonomousTick(context, {
  messagingMode = CONFIG.MESSAGING_MODE,
  pinnedOrganizationId = CONFIG.BILLING.orgId,
  orchestratorEnabled = CONFIG.PIPELINE.orchestratorEnabled,
} = {}) {
  return !orchestratorEnabled && (messagingMode !== 'pubsub'
    || Boolean(pinnedOrganizationId)
    || Boolean(context && context.organizationId));
}

function dispatchCoderTick(context, {
  pollOnce = orchestrator.pollOnce,
  start = orchestrator.start,
  logImpl = log,
  messagingMode = CONFIG.MESSAGING_MODE,
  pinnedOrganizationId = CONFIG.BILLING.orgId,
  orchestratorEnabled = CONFIG.PIPELINE.orchestratorEnabled,
} = {}) {
  const autonomous = shouldRunAutonomousTick(context, {
    messagingMode,
    pinnedOrganizationId,
    orchestratorEnabled,
  });
  if (autonomous) {
    Promise.resolve().then(() => (pollOnce ? pollOnce(context) : start(context))).catch((err) => {
      logImpl.error(`coder tick failed: ${err && err.message ? err.message : err}`);
    });
  } else if (orchestratorEnabled) {
    logImpl.warn('coder tick skipped: the durable pipeline orchestrator owns sequencing');
  } else {
    logImpl.warn('coder tick skipped: shared cloud runtime requires an organization context');
  }
  return { autonomous };
}

function isRejectedWorkspaceMessage(error) {
  return Boolean(error && (error.status === 400 || error.status === 403));
}

router.post('/coder', pushAuth(), async (req, res) => {
  const message = decodePushMessage(req.body);
  if (!message || !message.issueId) {
    // Malformed/poison message — ack so Pub/Sub does not redeliver forever.
    return res.status(204).end();
  }
  const conversationId = message.conversationId || null;
  const context = messageWorkspaceContext(message);
  const orgId = context.organizationId;
  const nativeProjectId = context.projectId;
  const eventContext = { organizationId: orgId, projectId: nativeProjectId };
  try {
    return await runMessageInWorkspace(message, async () => {
      if (CONFIG.BILLING.orgId && orgId && orgId !== CONFIG.BILLING.orgId) {
        if (conversationId) publishEvent(conversationId, {
          level: 'error',
          message: 'Selected organization does not match this deployment.',
          ts: new Date().toISOString(),
        }, eventContext);
        return res.status(204).end();
      }
      Promise.resolve(runTicket({
        issueId: String(message.issueId),
        conversationId,
        orgId: orgId || null,
        nativeProjectId: nativeProjectId || null,
        // Re-allowlist at the trust boundary; only the known selector survives.
        llmGateway: message.llmGateway === 'langsmith' ? 'langsmith' : null,
      })).catch((err) => {
        const detail = err && err.message ? err.message : String(err);
        log.error(`coder pubsub dispatch failed: ${detail}`);
        if (conversationId) publishEvent(
          conversationId,
          { level: 'error', message: `Coder dispatch failed: ${detail}`, ts: new Date().toISOString() },
          eventContext,
        );
      });
      return res.status(204).end();
    });
  } catch (err) {
    if (isRejectedWorkspaceMessage(err)) {
      log.warn(`coder message rejected: ${err.message}`);
      if (conversationId) publishEvent(
        conversationId,
        { level: 'error', message: err.message, ts: new Date().toISOString() },
        eventContext,
      );
      return res.status(204).end();
    }
    log.error(`coder workspace store initialization failed: ${err && err.message ? err.message : err}`);
    return res.status(503).end();
  }
});

router.post('/coder-tick', pushAuth(), async (req, res) => {
  const message = decodePushMessage(req.body) || {};
  // Board poll: find ready tickets and dispatch them (bounded by maxConcurrent).
  try {
    return await runMessageInWorkspace(message, async (context) => {
      dispatchCoderTick(context);
      return res.status(204).end();
    });
  } catch (err) {
    if (isRejectedWorkspaceMessage(err)) return res.status(204).end();
    log.error(`coder tick store initialization failed: ${err && err.message ? err.message : err}`);
    return res.status(503).end();
  }
});

module.exports = router;
module.exports.messageWorkspaceContext = messageWorkspaceContext;
module.exports.messageWorkspaceContextInput = messageWorkspaceContextInput;
module.exports.runMessageInWorkspace = runMessageInWorkspace;
module.exports.shouldRunAutonomousTick = shouldRunAutonomousTick;
module.exports.dispatchCoderTick = dispatchCoderTick;
module.exports.isRejectedWorkspaceMessage = isRejectedWorkspaceMessage;
