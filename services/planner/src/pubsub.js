'use strict';

const express = require('express');
const { decodePushMessage } = require('@ai-fleet/shared/messaging/publisher');
const { publishEvent, normalizeEventContext } = require('@ai-fleet/shared/messaging/events');
const { pushAuth } = require('@ai-fleet/shared/messaging/oidc');
const log = require('@ai-fleet/shared/logger');
const scheduler = require('@ai-fleet/shared/agent/scheduler');
const { processBillingSweep } = require('@ai-fleet/shared/billing/sweep');
const { CONFIG } = require('@ai-fleet/shared/config');
const store = require('@ai-fleet/shared/store');
const {
  normalizeWorkspaceContext,
  runWithWorkspaceContext,
  currentWorkspaceContext,
} = require('@ai-fleet/shared/store/workspace-context');

/**
 * Planner Pub/Sub push surface:
 *   POST /pubsub/planner       — on-demand enrichment request { projectId, projectName, assumedRole, conversationId }
 *   POST /pubsub/planner-tick  — Cloud Scheduler cadence tick (drain the queue)
 *
 * A planning job is queued + a processing tick fired, then we ack immediately
 * (the job runs in the scheduler). Lifecycle events stream to the conversation
 * SSE so the UI shows intermittent progress.
 */

const router = express.Router();

function stream(conversationId, context, level, message, extra = {}) {
  if (conversationId) {
    publishEvent(
      conversationId,
      { level, message, ts: new Date().toISOString(), ...extra },
      context,
    );
  }
}

function messageWorkspaceContext(message = {}) {
  return normalizeWorkspaceContext(messageWorkspaceContextInput(message));
}

function messageWorkspaceContextInput(message = {}) {
  return {
    organizationId: message.organizationId || message.orgId,
    // `message.projectId` is Linear's id, never the native workspace id.
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

function dispatchPlannerTick(context, {
  processBillingSweepImpl = processBillingSweep,
  processPending = scheduler.processPending,
  logImpl = log,
  messagingMode = CONFIG.MESSAGING_MODE,
  pinnedOrganizationId = CONFIG.BILLING.orgId,
  orchestratorEnabled = CONFIG.PIPELINE.orchestratorEnabled,
} = {}) {
  Promise.resolve().then(() => processBillingSweepImpl()).catch((err) => {
    logImpl.error(`billing sweep (planner tick) failed: ${err && err.message ? err.message : err}`);
  });
  const autonomous = shouldRunAutonomousTick(context, {
    messagingMode,
    pinnedOrganizationId,
    orchestratorEnabled,
  });
  if (autonomous) {
    Promise.resolve().then(() => processPending()).catch((err) => {
      logImpl.error(`planner tick failed: ${err && err.message ? err.message : err}`);
    });
  } else if (orchestratorEnabled) {
    logImpl.warn('planner tick skipped: the durable pipeline orchestrator owns sequencing');
  } else {
    logImpl.warn('planner tick skipped: shared cloud runtime requires an organization context');
  }
  return { autonomous };
}

function isRejectedWorkspaceMessage(error) {
  return Boolean(error && (error.status === 400 || error.status === 403));
}

router.post('/planner', pushAuth(), async (req, res) => {
  const message = decodePushMessage(req.body);
  if (!message) return res.status(204).end();
  const conversationId = message.conversationId || null;
  // `message.projectId` is the external Linear project. The native workspace
  // selection is deliberately carried in `nativeProjectId`, so never feed the
  // whole message to normalizeEventContext (which also accepts `projectId`).
  const context = normalizeEventContext(messageWorkspaceContext(message));

  const projectId = typeof message.projectId === 'string' ? message.projectId.trim() : '';
  const projectName = typeof message.projectName === 'string' ? message.projectName.slice(0, 200) : projectId;
  const orgId = context.organizationId;
  const nativeProjectId = context.projectId;

  try {
    return await runMessageInWorkspace(message, async () => {
      if (!projectId || projectId.length > 200) {
        stream(conversationId, context, 'error', 'projectId is required.');
        return res.status(204).end();
      }
      if (CONFIG.BILLING.orgId && orgId && orgId !== CONFIG.BILLING.orgId) {
        stream(conversationId, context, 'error', 'Selected organization does not match this deployment.');
        return res.status(204).end();
      }
      try {
        const job = scheduler.enqueue({
          projectId,
          projectName,
          assumedRole: message.assumedRole || null,
          orgId: orgId || null,
          nativeProjectId: nativeProjectId || null,
          // Re-allowlist at the trust boundary; only the known selector survives.
          llmGateway: message.llmGateway === 'langsmith' ? 'langsmith' : null,
        });
        stream(
          conversationId,
          context,
          'info',
          job ? `Queued planning job for ${projectName}` : `Planning job for ${projectName} is already queued`,
          job ? { jobId: job.id } : {},
        );
        Promise.resolve(scheduler.processPending())
          .then(() => stream(conversationId, context, 'info', 'Planner processing tick complete'))
          .catch((err) => {
            const detail = err && err.message ? err.message : String(err);
            log.error(`planner processPending failed: ${detail}`);
            stream(conversationId, context, 'error', `Planner failed: ${detail}`);
          });
      } catch (err) {
        const detail = err && err.message ? err.message : String(err);
        log.error(`planner pubsub handler failed: ${detail}`);
        stream(conversationId, context, 'error', `Planner error: ${detail}`);
      }
      return res.status(204).end();
    });
  } catch (err) {
    if (isRejectedWorkspaceMessage(err)) {
      log.warn(`planner message rejected: ${err.message}`);
      stream(conversationId, context, 'error', err.message);
      return res.status(204).end();
    }
    log.error(`planner workspace store initialization failed: ${err && err.message ? err.message : err}`);
    return res.status(503).end();
  }
});

router.post('/planner-tick', pushAuth(), async (req, res) => {
  const message = decodePushMessage(req.body) || {};
  // The billing sweep piggybacks on the planner cadence so it runs in cloud
  // (pubsub) mode without new infra; it self-gates on BILLING_SWEEP_ENABLED and
  // is idempotent (watermark + in-process guard), so a dedicated billing-tick
  // firing in the same window is harmless.
  try {
    return await runMessageInWorkspace(message, async (context) => {
      dispatchPlannerTick(context);
      return res.status(204).end();
    });
  } catch (err) {
    if (isRejectedWorkspaceMessage(err)) return res.status(204).end();
    log.error(`planner tick store initialization failed: ${err && err.message ? err.message : err}`);
    return res.status(503).end();
  }
});

router.post('/billing-tick', pushAuth(), async (req, res) => {
  const message = decodePushMessage(req.body) || {};
  try {
    return await runMessageInWorkspace(message, async () => {
      Promise.resolve(processBillingSweep()).catch((err) => {
        log.error(`billing tick failed: ${err && err.message ? err.message : err}`);
      });
      return res.status(204).end();
    });
  } catch (err) {
    if (isRejectedWorkspaceMessage(err)) return res.status(204).end();
    log.error(`billing tick store initialization failed: ${err && err.message ? err.message : err}`);
    return res.status(503).end();
  }
});

module.exports = router;
module.exports.messageWorkspaceContext = messageWorkspaceContext;
module.exports.messageWorkspaceContextInput = messageWorkspaceContextInput;
module.exports.runMessageInWorkspace = runMessageInWorkspace;
module.exports.shouldRunAutonomousTick = shouldRunAutonomousTick;
module.exports.dispatchPlannerTick = dispatchPlannerTick;
module.exports.isRejectedWorkspaceMessage = isRejectedWorkspaceMessage;
