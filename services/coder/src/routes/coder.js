'use strict';

const express = require('express');
const { asyncHandler } = require('@ai-fleet/shared/util');
const orchestrator = require('@ai-fleet/shared/agent/coder-orchestrator');
const { runTicket } = require('../run-ticket');

/**
 * Code-writer deep agent endpoints:
 *   GET  /api/coder             — monitor status + in-flight tickets
 *   POST /api/coder/run         — run the code-writer on one ticket { issueId }
 *   POST /api/coder/monitor     — start/resume/stop the board monitor { action }
 *
 * The dispatch itself lives in ../run-ticket.js so the HTTP route, the Pub/Sub
 * push handler, and the Cloud Run Job worker all share one implementation.
 */

const router = express.Router();

// GET /api/coder — status.
router.get('/', (req, res) => res.json(orchestrator.status()));

// POST /api/coder/run — dispatch a single ticket (async; watch logs / Linear Workpad / SSE).
router.post(
  '/run',
  asyncHandler(async (req, res) => {
    const issueId = req.body && String(req.body.issueId || '').trim();
    if (!issueId) return res.status(400).json({ error: 'issueId is required.' });
    const conversationId = req.body && req.body.conversationId ? String(req.body.conversationId) : null;
    try {
      const result = await runTicket({ issueId, conversationId });
      return res.status(202).json(result);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      if (status === 503) {
        return res.status(503).json({ error: err.message, paused: true, pauseReason: err.pauseReason || null });
      }
      return res.status(status).json({ error: err && err.message ? err.message : 'Coder run failed.' });
    }
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
