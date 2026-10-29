'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { CONFIG } = require('@ai-fleet/shared-core/config');
const log = require('@ai-fleet/shared-core/logger');
const { asyncHandler } = require('@ai-fleet/shared-core/util');
const store = require('@ai-fleet/shared-core/store');
const ledger = require('@ai-fleet/shared-core/billing/ledger');
const { paiseToInr } = require('@ai-fleet/shared-core/billing/pricing');
const { SHARED_ORG_ID } = require('@ai-fleet/shared-core/billing/org-context');
const cashfreeClient = require('@ai-fleet/shared-core/billing/cashfree-client');
const { processBillingSweep } = require('@ai-fleet/shared-core/billing/sweep');
const { renderDashboardHtml } = require('./ui');

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS = Object.freeze({ day: 1, week: 7, month: 30 });
const MAX_RECHARGE_PAISE = 100000000; // ₹1,000,000 sanity cap on a single top-up
const MAX_LEDGER_PAGE = 200;

function inrToPaise(inr) {
  const n = Number(inr);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

function resolveOrgContext(req) {
  // Respect explicit injected context headers from gateway proxy
  const orgHeader = req.get('x-ai-fleet-organization-id') || req.get('x-fleet-org-id');
  const userHeader = req.get('x-ai-fleet-user-id') || req.get('x-forwarded-user-id');
  const deploymentOrg = CONFIG.BILLING.orgId || '';
  const orgId = orgHeader || deploymentOrg || SHARED_ORG_ID;
  const isAdmin = true; // In microservice tier, gateway handles role gate; or default admin
  return { orgId, userId: userHeader || null, isAdmin };
}

function createBillingRouter() {
  const router = express.Router();

  // Summary
  router.get('/summary', asyncHandler(async (req, res) => {
    const { orgId, userId, isAdmin } = resolveOrgContext(req);
    const account = ledger.ensureAccount(orgId);
    const now = Date.now();
    const records = store.listUsageRecords().filter((r) => r.orgId === orgId);

    const spend = {};
    for (const [key, days] of Object.entries(PERIOD_DAYS)) {
      const cutoff = new Date(now - days * DAY_MS).toISOString();
      const inWindow = records.filter((r) => r.createdAt >= cutoff);
      const costPaise = inWindow.reduce((acc, r) => acc + (Number(r.costPaise) || 0), 0);
      const tokens = inWindow.reduce((acc, r) => acc + ((r.usage && Number(r.usage.totalTokens)) || 0), 0);
      spend[key] = {
        days,
        costPaise,
        costInr: paiseToInr(costPaise),
        tokens,
        runs: inWindow.length,
      };
    }

    const autoRecharge = account.autoRecharge || {};
    const thresholdMode = autoRecharge.mode || 'amount';
    const effectiveThresholdPaise = thresholdMode === 'percentage'
      ? Math.round((Number(account.initialCreditPaise || 0) * (Number(autoRecharge.thresholdPercent) || 20)) / 100)
      : (Number(autoRecharge.thresholdPaise) || 0);

    return res.json({
      orgId,
      currency: account.currency || 'INR',
      balancePaise: account.balancePaise,
      balanceInr: paiseToInr(account.balancePaise),
      initialCreditPaise: account.initialCreditPaise,
      initialCreditInr: paiseToInr(account.initialCreditPaise),
      totalDepositedPaise: account.totalDepositedPaise,
      totalDepositedInr: paiseToInr(account.totalDepositedPaise),
      totalSpentPaise: account.totalSpentPaise,
      totalSpentInr: paiseToInr(account.totalSpentPaise),
      spend,
      alertThresholdsInr: account.alertThresholdsInr || CONFIG.BILLING.defaultThresholdsInr,
      autoRecharge: {
        enabled: Boolean(autoRecharge.enabled),
        mode: thresholdMode,
        thresholdPaise: autoRecharge.thresholdPaise || 0,
        thresholdPercent: autoRecharge.thresholdPercent || 20,
        effectiveThresholdPaise,
        thresholdInr: paiseToInr(effectiveThresholdPaise),
        amountPaise: autoRecharge.amountPaise || 0,
        amountInr: paiseToInr(autoRecharge.amountPaise || 0),
        lastRechargedAt: autoRecharge.lastRechargedAt || null,
        cashfreeSubscriptionId: autoRecharge.cashfreeSubscriptionId || null,
      },
      notifyChannels: account.notifyChannels || { browser: true, email: false, slack: false },
      gateEnabled: account.gateEnabled !== false,
      sweepEnabled: CONFIG.BILLING.sweepEnabled,
      fxUsdToInr: CONFIG.BILLING.fxUsdToInr,
      isAdmin,
    });
  }));

  // Usage
  router.get('/usage', asyncHandler(async (req, res) => {
    const { orgId, userId } = resolveOrgContext(req);
    const period = String(req.query.period || 'week').toLowerCase();
    const groupBy = String(req.query.groupBy || 'project').toLowerCase();
    const days = PERIOD_DAYS[period] || PERIOD_DAYS.week;
    const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();

    let records = store.listUsageRecords().filter((r) => r.orgId === orgId && r.createdAt >= cutoff);
    if (orgId === SHARED_ORG_ID && userId) {
      records = records.filter((r) => r.userId === userId);
    }

    const groups = new Map();
    for (const r of records) {
      let key = 'unknown';
      let label = 'Unknown';
      if (groupBy === 'user') {
        key = r.userId || 'anonymous';
        label = r.userEmail || key;
      } else if (groupBy === 'task') {
        key = r.taskId || 'untasked';
        label = r.taskIdentifier || (r.taskId ? r.taskId.slice(0, 8) : 'Untasked');
      } else if (groupBy === 'day') {
        key = String(r.createdAt || '').slice(0, 10);
        label = key;
      } else {
        key = r.projectId || 'unassigned';
        label = r.projectName || key;
      }
      const acc = groups.get(key) || { key, label, costPaise: 0, tokens: 0, runs: 0, lastActivity: r.createdAt };
      acc.costPaise += Number(r.costPaise) || 0;
      acc.tokens += (r.usage && Number(r.usage.totalTokens)) || 0;
      acc.runs += 1;
      if (r.createdAt > acc.lastActivity) acc.lastActivity = r.createdAt;
      groups.set(key, acc);
    }

    const rows = [...groups.values()]
      .map((g) => ({ ...g, costInr: paiseToInr(g.costPaise) }))
      .sort((a, b) => b.costPaise - a.costPaise);

    return res.json({ period, days, groupBy, rows, totalRuns: records.length });
  }));

  // Ledger
  router.get('/ledger', asyncHandler(async (req, res) => {
    const { orgId } = resolveOrgContext(req);
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, MAX_LEDGER_PAGE));
    const entries = ledger.listEntries(orgId, { limit });
    return res.json({
      orgId,
      entries: entries.map((e) => ({
        ...e,
        amountInr: paiseToInr(e.amountPaise),
        balanceAfterInr: paiseToInr(e.balanceAfterPaise),
      })),
    });
  }));

  // Recharge
  router.post('/recharge', asyncHandler(async (req, res) => {
    const { orgId } = resolveOrgContext(req);
    const amountInr = Number(req.body && req.body.amountInr);
    const amountPaise = inrToPaise(amountInr);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0 || amountPaise > MAX_RECHARGE_PAISE) {
      return res.status(400).json({ error: `Amount must be between ₹1 and ₹${MAX_RECHARGE_PAISE / 100}`, code: 'invalid_amount' });
    }
    const entry = ledger.postEntry(orgId, {
      type: 'recharge',
      amountPaise,
      description: req.body.description || `Manual credit top-up (₹${amountInr})`,
      meta: { manual: true, source: 'admin-ui' },
    });
    return res.json({
      success: true,
      entry: { ...entry, amountInr: paiseToInr(entry.amountPaise), balanceAfterInr: paiseToInr(entry.balanceAfterPaise) },
    });
  }));

  // Config
  router.put('/config', asyncHandler(async (req, res) => {
    const { orgId } = resolveOrgContext(req);
    const body = req.body || {};
    const account = ledger.ensureAccount(orgId);

    let alertThresholdsInr = account.alertThresholdsInr;
    if (Array.isArray(body.alertThresholdsInr)) {
      alertThresholdsInr = body.alertThresholdsInr.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0);
    }

    let autoRecharge = account.autoRecharge || {};
    if (body.autoRecharge && typeof body.autoRecharge === 'object') {
      const mode = body.autoRecharge.mode === 'percentage' ? 'percentage' : 'amount';
      const thresholdPercent = Number(body.autoRecharge.thresholdPercent);
      const thresholdPaise = inrToPaise(body.autoRecharge.thresholdInr);
      const amountPaise = inrToPaise(body.autoRecharge.amountInr);

      autoRecharge = {
        ...autoRecharge,
        enabled: Boolean(body.autoRecharge.enabled),
        mode,
        thresholdPercent: Number.isFinite(thresholdPercent) ? Math.min(100, Math.max(1, thresholdPercent)) : (autoRecharge.thresholdPercent || 20),
        thresholdPaise: Number.isFinite(thresholdPaise) && thresholdPaise >= 0 ? thresholdPaise : (autoRecharge.thresholdPaise || 0),
        amountPaise: Number.isFinite(amountPaise) && amountPaise >= 0 ? amountPaise : (autoRecharge.amountPaise || 0),
      };
    }

    const notifyChannels = body.notifyChannels && typeof body.notifyChannels === 'object'
      ? {
          browser: body.notifyChannels.browser !== false,
          email: Boolean(body.notifyChannels.email),
          slack: Boolean(body.notifyChannels.slack),
        }
      : account.notifyChannels;

    const gateEnabled = typeof body.gateEnabled === 'boolean' ? body.gateEnabled : account.gateEnabled !== false;

    store.upsertBillingAccount(orgId, {
      alertThresholdsInr,
      autoRecharge,
      notifyChannels,
      gateEnabled,
    });

    return res.json({ success: true, autoRecharge, alertThresholdsInr, notifyChannels, gateEnabled });
  }));

  // Cashfree Mandate Creation
  router.post('/cashfree/create-mandate', asyncHandler(async (req, res) => {
    const { orgId, userId } = resolveOrgContext(req);
    const account = ledger.ensureAccount(orgId);
    const planId = `plan_${orgId}`;
    const subscriptionId = `sub_${orgId}_${Date.now()}`;
    const customerId = `cust_${orgId}`;
    const customerEmail = req.body.customerEmail || `${userId || 'admin'}@fleet.local`;
    const customerPhone = req.body.customerPhone || '9999999999';
    const returnUrl = req.body.returnUrl || 'http://localhost:3000/#cost';

    if (!cashfreeClient.isConfigured()) {
      return res.json({
        subscriptionId,
        subscriptionSessionId: `mock_session_${crypto.randomUUID()}`,
        authUrl: `${returnUrl}?cf_sub_id=${subscriptionId}&status=SUCCESS`,
        mock: true,
      });
    }

    await cashfreeClient.createPlan({
      planId,
      planName: `Auto-Reload for Org ${orgId}`,
      maxAmountInr: 100000,
    });

    const sub = await cashfreeClient.createSubscription({
      subscriptionId,
      planId,
      customerId,
      customerEmail,
      customerPhone,
      returnUrl,
    });

    return res.json(sub);
  }));

  // Cashfree Mandate Verification
  router.post('/cashfree/verify-mandate', asyncHandler(async (req, res) => {
    const { orgId } = resolveOrgContext(req);
    const subscriptionId = req.body && req.body.subscriptionId;
    if (!subscriptionId) {
      return res.status(400).json({ error: 'subscriptionId is required', code: 'missing_subscription_id' });
    }

    if (!cashfreeClient.isConfigured()) {
      const account = ledger.ensureAccount(orgId);
      const autoRecharge = { ...(account.autoRecharge || {}), cashfreeSubscriptionId: subscriptionId };
      store.upsertBillingAccount(orgId, { autoRecharge });
      return res.json({ success: true, status: 'ACTIVE', subscriptionId, mock: true });
    }

    const sub = await cashfreeClient.getSubscription(subscriptionId);
    if (sub && (sub.status === 'ACTIVE' || sub.status === 'INITIALIZED')) {
      const account = ledger.ensureAccount(orgId);
      const autoRecharge = { ...(account.autoRecharge || {}), cashfreeSubscriptionId: subscriptionId };
      store.upsertBillingAccount(orgId, { autoRecharge });
      return res.json({ success: true, status: sub.status, subscriptionId });
    }

    return res.status(400).json({ error: 'Mandate not active', status: sub ? sub.status : 'UNKNOWN' });
  }));

  // Cashfree Webhook
  router.post('/cashfree/webhook', asyncHandler(async (req, res) => {
    const signature = req.get('x-webhook-signature');
    const timestamp = req.get('x-webhook-timestamp');
    const rawBody = req.body;

    if (cashfreeClient.isConfigured()) {
      const isValid = cashfreeClient.verifyWebhookSignature({
        signature,
        rawBody: typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody),
        timestamp,
      });
      if (!isValid) {
        log.warn('Billing service rejected Cashfree webhook with invalid signature');
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    }

    const event = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    const type = event && event.type;
    const data = (event && event.data) || {};

    if (type === 'SUBSCRIPTION_STATUS_CHANGE') {
      const subscriptionId = data.subscription && data.subscription.subscription_id;
      const status = data.subscription && data.subscription.status;
      if (status === 'ACTIVE' && subscriptionId) {
        for (const acc of store.listBillingAccounts()) {
          if (acc.autoRecharge && acc.autoRecharge.cashfreeSubscriptionId === subscriptionId) {
            log.info(`Cashfree webhook confirmed active mandate ${subscriptionId} for org ${acc.orgId}`);
          }
        }
      }
    }

    return res.json({ received: true });
  }));

  return router;
}

function createApp(options = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Probes
  app.get('/healthz', (req, res) => res.json({ status: 'ok', service: 'billing' }));
  app.get('/readyz', (req, res) => res.json({ status: 'ok', service: 'billing' }));

  // Standalone Basic UI Dashboard
  app.get('/', (req, res) => {
    const orgId = CONFIG.BILLING.orgId || SHARED_ORG_ID;
    const account = ledger.ensureAccount(orgId);
    const html = renderDashboardHtml({
      account,
      cashfreeConfigured: cashfreeClient.isConfigured(),
      environment: process.env.CASHFREE_ENV || 'sandbox',
    });
    res.set('Content-Type', 'text/html').send(html);
  });
  app.get('/ui', (req, res) => res.redirect('/'));

  // Cloud Scheduler / PubSub sweep tick target
  app.post('/pubsub/billing-tick', asyncHandler(async (req, res) => {
    try {
      const result = await processBillingSweep();
      log.info(`Billing sweep completed via /pubsub/billing-tick: ${JSON.stringify(result)}`);
      return res.status(200).json({ status: 'ok', result });
    } catch (err) {
      log.error(`Billing sweep error: ${err && err.message ? err.message : err}`);
      return res.status(500).json({ error: err && err.message ? err.message : 'Sweep error' });
    }
  }));

  // Mount billing API under /api/billing and / for proxy compatibility
  const billingRouter = createBillingRouter();
  app.use('/api/billing', billingRouter);
  app.use('/', billingRouter);

  return app;
}

module.exports = { createApp, createBillingRouter };
