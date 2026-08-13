'use strict';

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared-core/config');
const { recordEulaDecision } = require('@ai-fleet/shared-core/store');
const { requireAuthenticated } = require('../auth');
const { eulaUserKey, resolveEulaStatus } = require('../eula');

/**
 * End User License Agreement acceptance API.
 *   GET  /api/eula  — the caller's current acceptance status (public: an
 *                     anonymous visitor simply sees `accepted:false`).
 *   POST /api/eula  — record the caller's decision ({ decision } +/- { via }).
 *                     Authenticated only; the key is derived server-side from the
 *                     verified identity, so the body can only carry the decision.
 */
const router = express.Router();

const DECISIONS = new Set(['accepted', 'rejected']);
const VIAS = new Set(['user', 'org-member']);

router.get('/', (req, res) => {
  const status = resolveEulaStatus(req);
  res.set('Cache-Control', 'no-store').json({
    version: status.version,
    status: status.status,
    acceptedVersion: status.acceptedVersion,
    accepted: status.accepted,
    via: status.via,
    at: status.at,
  });
});

router.post('/', requireAuthenticated(), (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const decision = typeof body.decision === 'string' ? body.decision : '';
  if (!DECISIONS.has(decision)) {
    return res.status(400).json({ error: 'decision must be "accepted" or "rejected".' });
  }
  const via = VIAS.has(body.via) ? body.via : 'user';
  const record = recordEulaDecision(eulaUserKey(req), { status: decision, version: CONFIG.EULA_VERSION, via });
  return res.set('Cache-Control', 'no-store').status(200).json({
    version: CONFIG.EULA_VERSION,
    status: record.status,
    accepted: decision === 'accepted',
    via: record.via,
    at: record.at,
  });
});

module.exports = router;
