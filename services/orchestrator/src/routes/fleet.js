'use strict';

/**
 * Fleet read surface — org/project-scoped listings for an authenticated caller.
 *
 * Four GET endpoints, all scoped to the request's gateway-validated organization
 * and project (`req.fleetContext`, bound by store-context). Mounted at
 * /api/agent/fleet inside the agent surface, so it inherits the gateway's
 * authentication + requireOrganizationContext + reverse proxy unchanged; these
 * handlers never re-derive tenancy from raw headers.
 *
 *   GET /agents         configured agent profiles (workspace store)
 *   GET /actors         live substrate actors (control-plane read)
 *   GET /actors/usage   per-actor compute sessions (billing ledger rows)
 *   GET /tokens/usage   per-run LLM token / credit usage (billing ledger rows)
 */

const express = require('express');
const { listActorSessions, listUsageRecords } = require('@software-factory/shared/store');
const { normalizeEventContext } = require('@software-factory/shared/messaging/events');
const { asyncHandler } = require('@software-factory/shared/util');
const wfStore = require('@software-factory/shared-core/workflow/store');
const { listRunningActors } = require('./substrate-access');

const router = express.Router();

const ACTOR_STATUSES = new Set(['RUNNING', 'CLOSED']);

// The validated tenant scope for this request. normalizeEventContext keeps
// projectId only when organizationId is present, matching the billing rows'
// orgId + projectId attribution.
function scopeOf(req) {
  return normalizeEventContext(req.fleetContext || {});
}

/**
 * Is a ledger row (actor session or usage record) inside the request scope?
 *
 * No organization header is the trusted, auth-disabled single-workspace profile,
 * so every row is in scope — the same local contract as agent.js's
 * recordsForRequest. With an org, the org must match; a project is enforced only
 * when one is selected (rows are not hidden from an org-wide listing).
 */
function inScope(row, scope) {
  if (!scope.organizationId) return true;
  const actual = normalizeEventContext(row);
  if (actual.organizationId !== scope.organizationId) return false;
  if (scope.projectId && actual.projectId !== scope.projectId) return false;
  return true;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// GET /api/agent/fleet/agents — the org/project's agent profiles (platform
// defaults merged with tenant copies, per the workflow store).
router.get(
  '/agents',
  asyncHandler(async (req, res) => {
    const agents = wfStore.listAgentProfiles();
    res.json({ agents, count: agents.length });
  })
);

// GET /api/agent/fleet/actors — live substrate actors for the tenant. Shares the
// single credential/atespace owner with /api/agent/substrate/status. `?projectId=`
// narrows the list by the plan-<project>- name prefix (display only).
router.get(
  '/actors',
  asyncHandler(async (req, res) => {
    res.json(await listRunningActors(req));
  })
);

// GET /api/agent/fleet/actors/usage — actor-compute sessions for the tenant.
// `?status=RUNNING|CLOSED` optionally narrows the ledger rows.
router.get(
  '/actors/usage',
  asyncHandler(async (req, res) => {
    const scope = scopeOf(req);
    const status = typeof req.query.status === 'string' ? req.query.status.trim().toUpperCase() : '';
    const rows = listActorSessions()
      .filter((s) => !status || !ACTOR_STATUSES.has(status) || s.status === status)
      .filter((s) => inScope(s, scope));
    const running = rows.filter((s) => s.status === 'RUNNING').length;
    const seconds = rows.reduce((sum, s) => sum + num(s.durationSeconds), 0);
    res.json({
      actorUsage: rows,
      totals: { sessions: rows.length, running, seconds },
    });
  })
);

// GET /api/agent/fleet/tokens/usage — per-run LLM token/credit usage rows for
// the tenant. Optional `?since=<ISO>` and `?limit=<n>` window the newest-first
// rows; `totals` aggregates across the (possibly windowed) set.
router.get(
  '/tokens/usage',
  asyncHandler(async (req, res) => {
    const scope = scopeOf(req);
    let rows = listUsageRecords().filter((r) => inScope(r, scope));
    const since = typeof req.query.since === 'string' ? req.query.since.trim() : '';
    if (since) rows = rows.filter((r) => String(r.createdAt || '') >= since);
    const rawLimit = Number.parseInt(typeof req.query.limit === 'string' ? req.query.limit : '', 10);
    const totals = rows.reduce((acc, r) => {
      const u = (r && r.usage) || {};
      acc.inputTokens += num(u.inputTokens);
      acc.outputTokens += num(u.outputTokens);
      acc.totalTokens += num(u.totalTokens);
      acc.costTokenCredits += num(r.costTokenCredits);
      acc.notionalCostTokenCredits += num(r.notionalCostTokenCredits);
      return acc;
    }, { inputTokens: 0, outputTokens: 0, totalTokens: 0, costTokenCredits: 0, notionalCostTokenCredits: 0, records: rows.length });
    if (Number.isFinite(rawLimit) && rawLimit >= 0) rows = rows.slice(0, rawLimit);
    res.json({ tokenUsage: rows, totals });
  })
);

module.exports = router;
