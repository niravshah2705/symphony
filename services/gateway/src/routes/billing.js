'use strict';

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared/config');
const { asyncHandler } = require('@ai-fleet/shared/util');
const store = require('@ai-fleet/shared/store');
const ledger = require('@ai-fleet/shared/billing/ledger');
const { paiseToInr } = require('@ai-fleet/shared/billing/pricing');
const { SHARED_ORG_ID } = require('@ai-fleet/shared/billing/org-context');
const { bearerToken } = require('../auth');
const { callJson } = require('../service-client');
const { requestContext } = require('../request-context');

/**
 * Cost-monitoring + billing API (gateway-owned). Billing state lives in the
 * shared JS store; org/project/user *names* come from the usage records.
 *
 * CROSS-TENANT ISOLATION (critical): every read scopes to the caller's selected
 * org, resolved SERVER-SIDE from the org service (`GET /api/v1/me`). The header
 * is only a requested selection; both gateway and org service validate it.
 * Mutations additionally require org-admin. On the
 * shared free-tier account (SHARED_ORG_ID) the per-project/user drill-down is
 * additionally scoped to the caller's own user so personal tenants can't see
 * each other's project names. Money is integer paise internally; INR is exposed
 * only for display.
 */

const router = express.Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS = Object.freeze({ day: 1, week: 7, month: 30 });
const MAX_RECHARGE_PAISE = 100000000; // ₹1,000,000 sanity cap on a single top-up
const MAX_LEDGER_PAGE = 200;

function inrToPaise(inr) {
  const n = Number(inr);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

/**
 * Resolve the caller's billing org + admin flag SERVER-SIDE. Never trusts client
 * input. Local dev (auth disabled) → the deployment org, admin. Otherwise the
 * org service is authoritative; an org-less (personal) user maps to the shared
 * free-tier account with no admin rights.
 */
async function resolveCallerOrg(req) {
  if (req.auth && req.auth.mode === 'disabled') {
    return { orgId: CONFIG.BILLING.orgId || SHARED_ORG_ID, userId: null, isAdmin: true };
  }
  let bearer = '';
  try {
    bearer = bearerToken(req);
  } catch (_) {
    bearer = '';
  }
  // On a dedicated stack the deployment IS one org; that identity is authoritative
  // for which billing data exists in this (namespaced) store.
  const deploymentOrg = CONFIG.BILLING.orgId || '';
  if (CONFIG.SERVICES.orgUrl && bearer) {
    try {
      const { status, data } = await callJson(CONFIG.SERVICES.orgUrl, '/api/v1/me', {
        userAuth: bearer,
        context: requestContext(req),
      });
      if (status === 200 && data) {
        const isAdmin = String(data.org_role || '').toUpperCase() === 'ORG_ADMIN';
        if (data.org_id) return { orgId: deploymentOrg || String(data.org_id), userId: data.user_id || null, isAdmin };
        // Signed in but org-less → shared free-tier account, read-only.
        return { orgId: deploymentOrg || SHARED_ORG_ID, userId: data.user_id || null, isAdmin: false };
      }
    } catch (_) {
      /* fall through to the safe default */
    }
  }
  return { orgId: deploymentOrg || SHARED_ORG_ID, userId: null, isAdmin: false };
}

/** Usage records for a caller, strictly scoped to their org (+ user on shared). */
function scopedUsageRecords(caller) {
  let records = store.listUsageRecords({ orgId: caller.orgId });
  if (caller.orgId === SHARED_ORG_ID && caller.userId) {
    records = records.filter((r) => r.userId === caller.userId);
  } else if (caller.orgId === SHARED_ORG_ID && !caller.userId) {
    // No user identity on the shared pool → expose nothing granular (safe default).
    records = [];
  }
  return records;
}

function sumWindow(records, days, now) {
  const cutoff = new Date(now - days * DAY_MS).toISOString();
  const scoped = records.filter((r) => String(r.createdAt || '') >= cutoff);
  const costPaise = scoped.reduce((s, r) => s + (Number(r.costPaise) || 0), 0);
  const tokens = scoped.reduce((s, r) => s + ((r.usage && Number(r.usage.totalTokens)) || 0), 0);
  return { runs: scoped.length, tokens, costInr: paiseToInr(costPaise) };
}

function requireAdmin(caller, res) {
  if (caller.isAdmin) return true;
  res.status(403).json({ error: 'Organization admin permission is required.', code: 'access_denied' });
  return false;
}

// GET /api/billing/summary — balance + period spend + config for the caller's org.
router.get('/summary', asyncHandler(async (req, res) => {
  const caller = await resolveCallerOrg(req);
  const account = store.getBillingAccount(caller.orgId);
  const balancePaise = account ? Number(account.balancePaise) || 0 : ledger.balanceFromLedger(caller.orgId);
  const records = scopedUsageRecords(caller);
  const now = Date.now();
  res.json({
    orgId: caller.orgId,
    isAdmin: caller.isAdmin,
    currency: 'INR',
    balanceInr: paiseToInr(balancePaise),
    balancePaise,
    initialCreditInr: account ? paiseToInr(account.initialCreditPaise) : paiseToInr(CONFIG.BILLING.initialCreditPaise),
    fxUsdToInr: CONFIG.BILLING.usdToInr,
    spend: {
      day: sumWindow(records, PERIOD_DAYS.day, now),
      week: sumWindow(records, PERIOD_DAYS.week, now),
      month: sumWindow(records, PERIOD_DAYS.month, now),
    },
    alertThresholdsInr: (account && account.alertThresholdsPaise ? account.alertThresholdsPaise : []).map(paiseToInr),
    autoRecharge: account && account.autoRecharge
      ? {
          enabled: Boolean(account.autoRecharge.enabled),
          thresholdInr: paiseToInr(account.autoRecharge.thresholdPaise),
          amountInr: paiseToInr(account.autoRecharge.amountPaise),
        }
      : { enabled: false, thresholdInr: 0, amountInr: 0 },
    notifyChannels: (account && account.notifyChannels) || { browser: true, email: false, slack: false },
    gateEnabled: account ? account.gateEnabled !== false : true,
    sweepEnabled: CONFIG.BILLING.sweepEnabled,
  });
}));

// GET /api/billing/usage?groupBy=project|user|day&period=day|week|month
router.get('/usage', asyncHandler(async (req, res) => {
  const caller = await resolveCallerOrg(req);
  const groupBy = ['project', 'user', 'task', 'day'].includes(req.query.groupBy) ? req.query.groupBy : 'project';
  const period = PERIOD_DAYS[req.query.period] ? req.query.period : 'week';
  const cutoff = new Date(Date.now() - PERIOD_DAYS[period] * DAY_MS).toISOString();
  const records = scopedUsageRecords(caller).filter((r) => String(r.createdAt || '') >= cutoff);

  const groups = new Map();
  for (const r of records) {
    let key;
    let label;
    if (groupBy === 'project') {
      key = r.projectId || 'unknown';
      label = r.projectName || r.projectId || 'Unattributed';
    } else if (groupBy === 'user') {
      key = r.userId || 'unknown';
      label = r.userEmail || r.userId || 'Unattributed';
    } else if (groupBy === 'task') {
      key = r.taskId || r.taskIdentifier || 'unknown';
      label = r.taskIdentifier || r.taskId || 'Unattributed';
    } else {
      key = String(r.createdAt || '').slice(0, 10) || 'unknown';
      label = key;
    }
    const g = groups.get(key) || { key, label, runs: 0, tokens: 0, costPaise: 0 };
    g.runs += 1;
    g.tokens += (r.usage && Number(r.usage.totalTokens)) || 0;
    g.costPaise += Number(r.costPaise) || 0;
    groups.set(key, g);
  }
  const rows = [...groups.values()]
    .map((g) => ({ key: g.key, label: g.label, runs: g.runs, tokens: g.tokens, costInr: paiseToInr(g.costPaise) }))
    .sort((a, b) => b.costInr - a.costInr);
  res.json({
    orgId: caller.orgId,
    groupBy,
    period,
    rows,
    totals: {
      runs: rows.reduce((s, r) => s + r.runs, 0),
      tokens: rows.reduce((s, r) => s + r.tokens, 0),
      costInr: paiseToInr(records.reduce((s, r) => s + (Number(r.costPaise) || 0), 0)),
    },
  });
}));

// GET /api/billing/usage/task/:taskId — per-task drill-down (scoped to the org).
router.get('/usage/task/:taskId', asyncHandler(async (req, res) => {
  const caller = await resolveCallerOrg(req);
  const taskId = String(req.params.taskId || '');
  const records = scopedUsageRecords(caller)
    .filter((r) => r.taskId === taskId || r.taskIdentifier === taskId)
    .map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      projectName: r.projectName,
      taskIdentifier: r.taskIdentifier,
      provider: r.provider,
      model: r.model,
      source: r.source,
      tokens: (r.usage && Number(r.usage.totalTokens)) || 0,
      costInr: paiseToInr(r.costPaise),
    }));
  res.json({ orgId: caller.orgId, taskId, records });
}));

// GET /api/billing/ledger?limit= — recent ledger line items (scoped to the org).
router.get('/ledger', asyncHandler(async (req, res) => {
  const caller = await resolveCallerOrg(req);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), MAX_LEDGER_PAGE);
  const entries = store.listLedgerEntries({ orgId: caller.orgId }).slice(0, limit).map((e) => ({
    id: e.id,
    type: e.type,
    amountInr: paiseToInr(e.amountPaise),
    description: e.description,
    createdAt: e.createdAt,
    meta: e.meta || {},
  }));
  res.json({ orgId: caller.orgId, entries });
}));

// POST /api/billing/recharge { amountInr } — manual top-up (org-admin only).
router.post('/recharge', asyncHandler(async (req, res) => {
  const caller = await resolveCallerOrg(req);
  if (!requireAdmin(caller, res)) return;
  const amountPaise = inrToPaise(req.body && req.body.amountInr);
  if (!Number.isFinite(amountPaise) || amountPaise <= 0 || amountPaise > MAX_RECHARGE_PAISE) {
    return res.status(400).json({ error: 'amountInr must be a positive amount within limits.' });
  }
  const { account } = ledger.postEntry(caller.orgId, {
    type: 'recharge',
    amountPaise,
    description: 'Manual recharge',
    meta: { manual: true },
  });
  res.json({ orgId: caller.orgId, balanceInr: paiseToInr(account.balancePaise), balancePaise: account.balancePaise });
}));

// PUT /api/billing/config — thresholds / auto-recharge / channels (org-admin only).
router.put('/config', asyncHandler(async (req, res) => {
  const caller = await resolveCallerOrg(req);
  if (!requireAdmin(caller, res)) return;
  ledger.ensureAccount(caller.orgId);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const patch = {};

  if (Array.isArray(body.alertThresholdsInr)) {
    const thresholds = body.alertThresholdsInr
      .map(inrToPaise)
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a);
    patch.alertThresholdsPaise = thresholds;
    patch.lastAlertedThresholdPaise = null; // re-arm on a threshold change
  }
  if (body.autoRecharge && typeof body.autoRecharge === 'object') {
    const ar = body.autoRecharge;
    const thresholdPaise = inrToPaise(ar.thresholdInr);
    const amountPaise = inrToPaise(ar.amountInr);
    patch.autoRecharge = {
      enabled: Boolean(ar.enabled),
      thresholdPaise: Number.isFinite(thresholdPaise) ? thresholdPaise : 0,
      amountPaise: Number.isFinite(amountPaise) && amountPaise > 0 ? Math.min(amountPaise, MAX_RECHARGE_PAISE) : 0,
      lastRechargedAt: null,
    };
  }
  if (body.notifyChannels && typeof body.notifyChannels === 'object') {
    patch.notifyChannels = {
      browser: body.notifyChannels.browser !== false,
      email: Boolean(body.notifyChannels.email),
      slack: Boolean(body.notifyChannels.slack),
    };
  }
  if (Array.isArray(body.notifyEmails)) {
    patch.notifyEmails = body.notifyEmails
      .map((e) => String(e || '').trim())
      .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
      .slice(0, 20);
  }
  if (typeof body.gateEnabled === 'boolean') patch.gateEnabled = body.gateEnabled;

  const account = store.upsertBillingAccount(caller.orgId, patch);
  res.json({
    orgId: caller.orgId,
    alertThresholdsInr: (account.alertThresholdsPaise || []).map(paiseToInr),
    autoRecharge: {
      enabled: Boolean(account.autoRecharge && account.autoRecharge.enabled),
      thresholdInr: paiseToInr(account.autoRecharge && account.autoRecharge.thresholdPaise),
      amountInr: paiseToInr(account.autoRecharge && account.autoRecharge.amountPaise),
    },
    notifyChannels: account.notifyChannels,
    notifyEmails: account.notifyEmails || [],
    gateEnabled: account.gateEnabled !== false,
  });
}));

module.exports = router;
module.exports.resolveCallerOrg = resolveCallerOrg;
module.exports.scopedUsageRecords = scopedUsageRecords;
