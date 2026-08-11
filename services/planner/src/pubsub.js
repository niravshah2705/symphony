'use strict';

const express = require('express');
const { decodePushMessage } = require('@ai-fleet/shared/messaging/publisher');
const { publishEvent } = require('@ai-fleet/shared/messaging/events');
const { pushAuth } = require('@ai-fleet/shared/messaging/oidc');
const log = require('@ai-fleet/shared/logger');
const scheduler = require('@ai-fleet/shared/agent/scheduler');
const { processBillingSweep } = require('@ai-fleet/shared/billing/sweep');

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

function stream(conversationId, level, message, extra = {}) {
  if (conversationId) publishEvent(conversationId, { level, message, ts: new Date().toISOString(), ...extra });
}

router.post('/planner', pushAuth(), (req, res) => {
  const message = decodePushMessage(req.body);
  if (!message) return res.status(204).end();
  const conversationId = message.conversationId || null;

  const projectId = typeof message.projectId === 'string' ? message.projectId.trim() : '';
  if (!projectId || projectId.length > 200) {
    stream(conversationId, 'error', 'projectId is required.');
    return res.status(204).end();
  }
  const projectName = typeof message.projectName === 'string' ? message.projectName.slice(0, 200) : projectId;

  try {
    const job = scheduler.enqueue({ projectId, projectName, assumedRole: message.assumedRole || null });
    stream(conversationId, 'info', `Queued planning job for ${projectName}`, { jobId: job.id });
    Promise.resolve(scheduler.processPending())
      .then(() => stream(conversationId, 'info', 'Planner processing tick complete'))
      .catch((err) => {
        const detail = err && err.message ? err.message : String(err);
        log.error(`planner processPending failed: ${detail}`);
        stream(conversationId, 'error', `Planner failed: ${detail}`);
      });
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    log.error(`planner pubsub handler failed: ${detail}`);
    stream(conversationId, 'error', `Planner error: ${detail}`);
  }
  return res.status(204).end();
});

router.post('/planner-tick', pushAuth(), (req, res) => {
  // The billing sweep piggybacks on the planner cadence so it runs in cloud
  // (pubsub) mode without new infra; it self-gates on BILLING_SWEEP_ENABLED and
  // is idempotent (watermark + in-process guard), so a dedicated billing-tick
  // firing in the same window is harmless.
  Promise.resolve(processBillingSweep()).catch((err) => {
    log.error(`billing sweep (planner tick) failed: ${err && err.message ? err.message : err}`);
  });
  Promise.resolve(scheduler.processPending()).catch((err) => {
    log.error(`planner tick failed: ${err && err.message ? err.message : err}`);
  });
  return res.status(204).end();
});

router.post('/billing-tick', pushAuth(), (req, res) => {
  Promise.resolve(processBillingSweep()).catch((err) => {
    log.error(`billing tick failed: ${err && err.message ? err.message : err}`);
  });
  return res.status(204).end();
});

module.exports = router;
