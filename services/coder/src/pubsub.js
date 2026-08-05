'use strict';

const express = require('express');
const { decodePushMessage } = require('@ai-fleet/shared/messaging/publisher');
const { publishEvent } = require('@ai-fleet/shared/messaging/events');
const { pushAuth } = require('@ai-fleet/shared/messaging/oidc');
const log = require('@ai-fleet/shared/logger');
const orchestrator = require('@ai-fleet/shared/agent/coder-orchestrator');
const { runTicket } = require('./run-ticket');

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

router.post('/coder', pushAuth(), (req, res) => {
  const message = decodePushMessage(req.body);
  if (!message || !message.issueId) {
    // Malformed/poison message — ack so Pub/Sub does not redeliver forever.
    return res.status(204).end();
  }
  const conversationId = message.conversationId || null;
  Promise.resolve(runTicket({ issueId: String(message.issueId), conversationId })).catch((err) => {
    const detail = err && err.message ? err.message : String(err);
    log.error(`coder pubsub dispatch failed: ${detail}`);
    if (conversationId) publishEvent(conversationId, { level: 'error', message: `Coder dispatch failed: ${detail}`, ts: new Date().toISOString() });
  });
  return res.status(204).end();
});

router.post('/coder-tick', pushAuth(), (req, res) => {
  // Board poll: find ready tickets and dispatch them (bounded by maxConcurrent).
  Promise.resolve(orchestrator.pollOnce ? orchestrator.pollOnce() : orchestrator.start()).catch((err) => {
    log.error(`coder tick failed: ${err && err.message ? err.message : err}`);
  });
  return res.status(204).end();
});

module.exports = router;
