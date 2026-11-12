'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { CONFIG } = require('@ai-fleet/shared-core/config');
const { asyncHandler } = require('@ai-fleet/shared-core/util');
const log = require('@ai-fleet/shared-core/logger');
const store = require('@ai-fleet/shared-core/store');
const ledger = require('@ai-fleet/shared-core/billing/ledger');
const { paiseToInr } = require('@ai-fleet/shared-core/billing/pricing');
const { SHARED_ORG_ID } = require('@ai-fleet/shared-core/billing/org-context');
const cashfreeClient = require('@ai-fleet/shared-core/billing/cashfree-client');
const gst = require('@ai-fleet/shared-core/billing/gst');
const moneyWire = require('@ai-fleet/shared-core/billing/money-wire');
const providers = require('./payment-providers');
const { settle, allowsMockPayments } = require('./recharge-settle');

/**
 * Cost-monitoring + billing API. Billing state lives in the shared JS store;
 * org/project/user *names* come from the usage records.
 *
 * CROSS-TENANT ISOLATION (critical): the gateway resolves the caller's billing
 * org + admin flag SERVER-SIDE from the org service and forwards them as the
 * `x-ai-fleet-billing-*` headers below. Those headers are trustworthy because
 * this service is bound to the gateway's service account by Cloud Run IAM and
 * the gateway proxy builds its request headers from scratch — a browser value
 * can never arrive here uninvited. Every read scopes to that org, and mutations
 * additionally require org-admin (re-checked here, not only at the edge). On the
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

const BILLING_ORG_HEADER = 'x-ai-fleet-billing-org-id';
const BILLING_ROLE_HEADER = 'x-ai-fleet-billing-org-role';
const BILLING_USER_HEADER = 'x-ai-fleet-billing-user-id';

/**
 * Rupees in, integer paise out — on the digits, via `money-wire`. The previous
 * `Math.round(Number(x) * 100)` was exact for the values a UI form sends and
 * wrong for the ones a script sends (₹1.005 → 101p in some orders, 100p in
 * others). Anything unparseable is NaN, which every caller already rejects.
 */
function inrToPaise(inr) {
  const text = String(inr == null ? '' : inr).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return NaN;
  try {
    return moneyWire.paiseFromDecimal(text);
  } catch (_) {
    return NaN;
  }
}

/**
 * A recharge subtotal. Stricter than `inrToPaise`: it must be a positive whole
 * number of *rupees*, because 1 credit = ₹1 (decision D6) and FlexPrice counts
 * credits, so ₹500.50 has no representation in the wallet it would be spent from.
 */
function parseRechargeSubtotal(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return { error: 'amountInr must be an amount of rupees, e.g. 500 or 500.00.' };
  }
  let paise;
  try {
    paise = moneyWire.paiseFromDecimal(text);
  } catch (_) {
    return { error: 'amountInr is not a valid amount.' };
  }
  if (!Number.isSafeInteger(paise) || paise <= 0) return { error: 'amountInr must be greater than zero.' };
  if (paise > MAX_RECHARGE_PAISE) return { error: `amountInr must be at most ₹${MAX_RECHARGE_PAISE / 100}.` };
  if (paise % moneyWire.PAISE_PER_CREDIT !== 0) {
    return { error: 'Recharge amounts must be whole rupees — 1 credit = ₹1, so paise cannot be credited.' };
  }
  return { paise };
}

function parseCouponBps(value) {
  if (value == null || value === '') return { bps: 0 };
  const bps = Number(value);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    return { error: 'couponBps must be an integer between 0 and 10000 (basis points of bonus credit).' };
  }
  return { bps };
}

/**
 * The GSTIN the org saved, used only if it is a valid one. An invalid string is
 * not a hard error at quote time — the place of supply then falls back to the
 * supplier state and `placeOfSupply.assumed` says so in the response, which is
 * the honest presentation: an intra-state supply may not be taxed as IGST just
 * because a customer typed a bad GSTIN.
 */
function customerGstinFor(paymentInfo) {
  const raw = String((paymentInfo && paymentInfo.taxId) || '').trim();
  if (!raw) return { gstin: '', invalid: false };
  const parsed = gst.parseGstin(raw);
  return parsed.present && parsed.valid
    ? { gstin: raw.toUpperCase(), invalid: false }
    : { gstin: '', invalid: true };
}

/** The supplier's own state: the other half of every GST split, config-owned. */
function supplierStateCode() {
  return String(CONFIG.FLEXPRICE.supplierStateCode || '').trim();
}

function quoteRecharge({ subtotalPaise, couponBps = 0, paymentInfo = {} }) {
  const state = supplierStateCode();
  if (!state) {
    const err = new Error('GST cannot be computed: FLEXPRICE_SUPPLIER_STATE_CODE is not configured on this server.');
    err.status = 503;
    err.code = 'supplier_state_not_configured';
    throw err;
  }
  const { gstin, invalid } = customerGstinFor(paymentInfo);
  const quote = gst.quote({
    subtotalPaise,
    couponBps,
    supplierStateCode: state,
    ...(gstin ? { customerGstin: gstin } : {}),
  });
  return { quote, supplierStateCode: state, customerGstin: gstin, gstinIgnored: invalid };
}

/** What the browser is shown: every number as paise AND as a decimal string. */
function quoteView(quote) {
  return {
    subtotalPaise: quote.subtotalPaise,
    subtotalInr: moneyWire.decimalFromPaise(quote.subtotalPaise),
    components: quote.components.map((c) => ({
      name: c.name,
      rateBps: c.rateBps,
      paise: c.paise,
      inr: moneyWire.decimalFromPaise(c.paise),
    })),
    gstPaise: quote.gstPaise,
    gstInr: moneyWire.decimalFromPaise(quote.gstPaise),
    totalPaise: quote.totalPaise,
    totalInr: moneyWire.decimalFromPaise(quote.totalPaise),
    bonusPaise: quote.bonusPaise || 0,
    bonusInr: moneyWire.decimalFromPaise(quote.bonusPaise || 0),
    credits: moneyWire.paiseToCredits(quote.subtotalPaise),
    placeOfSupply: quote.placeOfSupply,
  };
}

/** `order_<org>_<ts>` plus a suffix, so two recharges in one millisecond are two intents. */
function newOrderId(orgId) {
  const sanitized = String(orgId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `order_${sanitized}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * The caller's billing org + admin flag, taken from the gateway's server-derived
 * context. Absent headers resolve to the deployment's own org with no admin
 * rights, so a direct caller (or a gateway that could not identify the user)
 * reads the tenant it belongs to and can never mutate it.
 */
function resolveCallerOrg(req) {
  const orgId = String(req.get(BILLING_ORG_HEADER) || '').trim()
    || CONFIG.BILLING.orgId
    || SHARED_ORG_ID;
  const userId = String(req.get(BILLING_USER_HEADER) || '').trim() || null;
  const isAdmin = String(req.get(BILLING_ROLE_HEADER) || '').trim().toUpperCase() === 'ORG_ADMIN';
  return { orgId, userId, isAdmin };
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
  // Money the platform routed but never paid. Reported next to the charge, not
  // inside it: an org that brought its own key must see the value it consumed and
  // a zero that it can verify against its own provider invoice.
  const notionalPaise = scoped.reduce((s, r) => s + (Number(r.notionalCostPaise) || 0), 0);
  return {
    runs: scoped.length,
    tokens,
    costInr: paiseToInr(costPaise),
    notionalInr: paiseToInr(notionalPaise),
  };
}

/**
 * The same window split by which key paid the provider. A record with no
 * `billingSource` predates BYOK metering, and only a platform key was reachable
 * then, so it belongs with `managed`.
 */
/** One empty spend bucket; both series start at zero rather than at absent. */
function newSourceBucket() {
  return { runs: 0, tokens: 0, costPaise: 0, notionalPaise: 0 };
}

function bySourceWindow(records, days, now) {
  const cutoff = new Date(now - days * DAY_MS).toISOString();
  const scoped = records.filter((r) => String(r.createdAt || '') >= cutoff);
  // Both series always present, even at zero: the visible zero is the BYOK value
  // proposition, and a missing key would render as "no data" instead.
  const sources = { managed: newSourceBucket(), customer: newSourceBucket() };
  for (const r of scoped) {
    const source = r.billingSource || 'managed';
    const acc = sources[source] || { runs: 0, tokens: 0, costPaise: 0, notionalPaise: 0 };
    acc.runs += 1;
    acc.tokens += (r.usage && Number(r.usage.totalTokens)) || 0;
    acc.costPaise += Number(r.costPaise) || 0;
    acc.notionalPaise += Number(r.notionalCostPaise) || 0;
    sources[source] = acc;
  }
  return {
    retentionDays: CONFIG.BILLING.usageRetentionDays,
    // The notional figure exists ONLY in these pruned records — a customer run
    // posts no ledger entry, because no platform money was spent. So the window is
    // the real history boundary and the UI must say so rather than imply a total.
    historyTruncated: store.usageRecordCount() >= store.USAGE_RECORD_CAP,
    sources: Object.fromEntries(Object.entries(sources).map(([key, acc]) => [key, {
      ...acc,
      costInr: paiseToInr(acc.costPaise),
      notionalInr: paiseToInr(acc.notionalPaise),
    }])),
  };
}

function requireAdmin(caller, res) {
  if (caller.isAdmin) return true;
  res.status(403).json({ error: 'Organization admin permission is required.', code: 'access_denied' });
  return false;
}

// GET /api/billing/summary — balance + period spend + config for the caller's org.
router.get('/summary', asyncHandler(async (req, res) => {
  const caller = resolveCallerOrg(req);
  const account = store.getBillingAccount(caller.orgId);
  const balancePaise = account ? Number(account.balancePaise) || 0 : ledger.balanceFromLedger(caller.orgId);
  const fundsAvailable = balancePaise > 0;
  const records = scopedUsageRecords(caller);
  const now = Date.now();
  res.json({
    orgId: caller.orgId,
    isAdmin: caller.isAdmin,
    currency: 'INR',
    balanceInr: paiseToInr(balancePaise),
    balancePaise,
    fundsAvailable,
    fundStatus: fundsAvailable ? 'available' : 'unavailable',
    sandboxCreationDisabled: !fundsAvailable,
    scheduledCallsDisabled: !fundsAvailable,
    initialCreditInr: account ? paiseToInr(account.initialCreditPaise) : paiseToInr(CONFIG.BILLING.initialCreditPaise),
    fxUsdToInr: CONFIG.BILLING.usdToInr,
    spend: {
      day: sumWindow(records, PERIOD_DAYS.day, now),
      week: sumWindow(records, PERIOD_DAYS.week, now),
      month: sumWindow(records, PERIOD_DAYS.month, now),
    },
    // The same windows split by which key paid the provider. One combined number
    // would hide the whole point: what the platform charged versus what the org's
    // own key already covered.
    bySource: {
      day: bySourceWindow(records, PERIOD_DAYS.day, now),
      week: bySourceWindow(records, PERIOD_DAYS.week, now),
      month: bySourceWindow(records, PERIOD_DAYS.month, now),
    },
    alertThresholdsInr: (account && account.alertThresholdsPaise ? account.alertThresholdsPaise : []).map(paiseToInr),
    paymentInfo: (account && account.paymentInfo) || {
      billingName: '',
      billingEmail: '',
      billingPhone: '',
      taxId: '',
      address: null,
      updatedAt: null,
    },
    autoRecharge: account && account.autoRecharge
      ? {
          enabled: Boolean(account.autoRecharge.enabled),
          mode: account.autoRecharge.mode || 'amount',
          thresholdInr: paiseToInr(account.autoRecharge.thresholdPaise),
          thresholdPercent: account.autoRecharge.thresholdPercent || 20,
          amountInr: paiseToInr(account.autoRecharge.amountPaise),
          cashfreeSubscriptionId: account.autoRecharge.cashfreeSubscriptionId || null,
          paymentMethodType: account.autoRecharge.paymentMethodType || null,
          cashfreeConfigured: cashfreeClient.isConfigured(),
        }
      : {
          enabled: false,
          mode: 'amount',
          thresholdInr: 0,
          thresholdPercent: 20,
          amountInr: 0,
          cashfreeSubscriptionId: null,
          paymentMethodType: null,
          cashfreeConfigured: cashfreeClient.isConfigured(),
        },
    notifyChannels: (account && account.notifyChannels) || { browser: true, email: false, slack: false },
    gateEnabled: account ? account.gateEnabled !== false : true,
    sweepEnabled: CONFIG.BILLING.sweepEnabled,
  });
}));

// GET /api/billing/usage?groupBy=project|user|day&period=day|week|month
router.get('/usage', asyncHandler(async (req, res) => {
  const caller = resolveCallerOrg(req);
  const groupBy = ['project', 'user', 'task', 'day', 'billingSource'].includes(req.query.groupBy) ? req.query.groupBy : 'project';
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
    } else if (groupBy === 'billingSource') {
      key = r.billingSource || 'managed';
      label = key === 'customer' ? 'Your key (not charged)' : 'Managed spend';
    } else {
      key = String(r.createdAt || '').slice(0, 10) || 'unknown';
      label = key;
    }
    const g = groups.get(key) || {
      key, label, runs: 0, tokens: 0, costPaise: 0, notionalPaise: 0,
    };
    g.runs += 1;
    g.tokens += (r.usage && Number(r.usage.totalTokens)) || 0;
    g.costPaise += Number(r.costPaise) || 0;
    g.notionalPaise += Number(r.notionalCostPaise) || 0;
    groups.set(key, g);
  }
  const rows = [...groups.values()]
    .sort((a, b) => (b.costPaise + b.notionalPaise) - (a.costPaise + a.notionalPaise))
    .map((g) => ({
      key: g.key,
      label: g.label,
      runs: g.runs,
      tokens: g.tokens,
      costInr: paiseToInr(g.costPaise),
      notionalInr: paiseToInr(g.notionalPaise),
    }));
  res.json({
    orgId: caller.orgId,
    groupBy,
    period,
    rows,
    totals: {
      runs: rows.reduce((s, r) => s + r.runs, 0),
      tokens: rows.reduce((s, r) => s + r.tokens, 0),
      costInr: paiseToInr(records.reduce((s, r) => s + (Number(r.costPaise) || 0), 0)),
      notionalInr: paiseToInr(records.reduce((s, r) => s + (Number(r.notionalCostPaise) || 0), 0)),
    },
  });
}));

// GET /api/billing/usage/task/:taskId — per-task drill-down (scoped to the org).
router.get('/usage/task/:taskId', asyncHandler(async (req, res) => {
  const caller = resolveCallerOrg(req);
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
      // Each row explains its own zero, so a per-run dispute needs no join.
      billingSource: r.billingSource || 'managed',
      notionalInr: paiseToInr(r.notionalCostPaise),
      traceId: r.traceId || null,
      runId: r.runId || null,
    }));
  res.json({ orgId: caller.orgId, taskId, records });
}));

// GET /api/billing/ledger?limit= — recent ledger line items (scoped to the org).
router.get('/ledger', asyncHandler(async (req, res) => {
  const caller = resolveCallerOrg(req);
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

// POST /api/billing/recharge { amountInr, couponBps? } — the GST quote ONLY.
//
// It credits nothing. Before this route's predecessor, POST /recharge moved money
// straight into the org's balance with no payment behind it at all; the credit now
// lives in `recharge-settle.js` and can only be reached by an order the provider
// confirms. What remains here is the breakdown the customer must see before paying:
// ₹500 + CGST ₹45 + SGST ₹45 = ₹590, for 500 credits.
router.post('/recharge', asyncHandler(async (req, res) => {
  const caller = resolveCallerOrg(req);
  if (!requireAdmin(caller, res)) return;

  const subtotal = parseRechargeSubtotal(req.body && req.body.amountInr);
  if (subtotal.error) return res.status(400).json({ error: subtotal.error, code: 'invalid_amount' });
  const coupon = parseCouponBps(req.body && req.body.couponBps);
  if (coupon.error) return res.status(400).json({ error: coupon.error, code: 'invalid_coupon' });

  const account = store.getBillingAccount(caller.orgId);
  const { quote, gstinIgnored } = quoteRecharge({
    subtotalPaise: subtotal.paise,
    couponBps: coupon.bps,
    paymentInfo: (account && account.paymentInfo) || {},
  });
  res.json({
    orgId: caller.orgId,
    quote: quoteView(quote),
    // The quote is not an order: nothing is reserved, and the amount must be
    // re-quoted by create-order in case the org's GST details changed meanwhile.
    settled: false,
    ...(gstinIgnored ? { warnings: ['saved_tax_id_invalid'] } : {}),
  });
}));

// PUT /api/billing/config — thresholds / auto-recharge / channels (org-admin only).
router.put('/config', asyncHandler(async (req, res) => {
  const caller = resolveCallerOrg(req);
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
    const existingAccount = store.getBillingAccount(caller.orgId);
    const existingAr = (existingAccount && existingAccount.autoRecharge) || {};

    const mode = ['amount', 'percentage'].includes(ar.mode) ? ar.mode : 'amount';
    const thresholdPaise = inrToPaise(ar.thresholdInr);
    const amountPaise = inrToPaise(ar.amountInr);
    const thresholdPercent = Number.isFinite(Number(ar.thresholdPercent)) ? Math.max(1, Math.min(100, Number(ar.thresholdPercent))) : 20;

    patch.autoRecharge = {
      ...existingAr,
      enabled: Boolean(ar.enabled),
      mode,
      thresholdPaise: Number.isFinite(thresholdPaise) ? thresholdPaise : 0,
      thresholdPercent,
      amountPaise: Number.isFinite(amountPaise) && amountPaise > 0 ? Math.min(amountPaise, MAX_RECHARGE_PAISE) : 0,
      lastRechargedAt: null,
    };
  }
  if (body.paymentInfo && typeof body.paymentInfo === 'object') {
    const existingAccount = store.getBillingAccount(caller.orgId);
    const existingInfo = (existingAccount && existingAccount.paymentInfo) || {};
    // The GSTIN decides the place of supply on every recharge this org buys, and
    // it is the field Zoho needs. Storing garbage unvalidated (which is what this
    // did) meant a typo silently produced the wrong tax split; now it is refused
    // on the way in and, if it somehow arrives anyway, `customerGstinFor` ignores
    // it and the quote reports `assumed: true`.
    const incomingTaxId = body.paymentInfo.taxId !== undefined
      ? String(body.paymentInfo.taxId || '').trim().toUpperCase().slice(0, 50)
      : String(existingInfo.taxId || '');
    if (incomingTaxId) {
      const parsed = gst.parseGstin(incomingTaxId);
      if (!parsed.valid) {
        return res.status(400).json({
          error: `That does not look like a GSTIN (${parsed.reason}). Leave it blank for B2C billing — GST will then be charged on the basis of your billing state.`,
          code: 'invalid_gstin',
        });
      }
    }
    patch.paymentInfo = {
      billingName: String(body.paymentInfo.billingName || existingInfo.billingName || '').slice(0, 100),
      billingEmail: String(body.paymentInfo.billingEmail || existingInfo.billingEmail || '').slice(0, 100),
      billingPhone: String(body.paymentInfo.billingPhone || existingInfo.billingPhone || '').slice(0, 20),
      taxId: incomingTaxId,
      provider: providers.normalizeProvider(body.paymentInfo.provider)
        || providers.normalizeProvider(existingInfo.provider)
        || 'cashfree',
      address: body.paymentInfo.address && typeof body.paymentInfo.address === 'object'
        ? {
            line1: String(body.paymentInfo.address.line1 || '').slice(0, 120),
            city: String(body.paymentInfo.address.city || '').slice(0, 60),
            state: String(body.paymentInfo.address.state || '').slice(0, 60),
            postalCode: String(body.paymentInfo.address.postalCode || '').slice(0, 20),
            country: String(body.paymentInfo.address.country || 'IN').slice(0, 10),
          }
        : (existingInfo.address || null),
      updatedAt: new Date().toISOString(),
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
    paymentInfo: account.paymentInfo || null,
    autoRecharge: {
      enabled: Boolean(account.autoRecharge && account.autoRecharge.enabled),
      mode: account.autoRecharge && account.autoRecharge.mode || 'amount',
      thresholdInr: paiseToInr(account.autoRecharge && account.autoRecharge.thresholdPaise),
      thresholdPercent: account.autoRecharge && account.autoRecharge.thresholdPercent || 20,
      amountInr: paiseToInr(account.autoRecharge && account.autoRecharge.amountPaise),
      cashfreeSubscriptionId: account.autoRecharge && account.autoRecharge.cashfreeSubscriptionId || null,
      paymentMethodType: account.autoRecharge && account.autoRecharge.paymentMethodType || null,
    },
    notifyChannels: account.notifyChannels,
    notifyEmails: account.notifyEmails || [],
    gateEnabled: account.gateEnabled !== false,
  });
}));

// POST /api/billing/cashfree/create-mandate — create On-Demand Cashfree subscription for mandate setup
router.post('/cashfree/create-mandate', asyncHandler(async (req, res) => {
  const caller = resolveCallerOrg(req);
  if (!requireAdmin(caller, res)) return;

  if (!cashfreeClient.isConfigured()) {
    return res.status(400).json({ error: 'Cashfree Payments is not configured on this server.' });
  }

  const sanitizedOrg = String(caller.orgId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const subscriptionId = `sub_${sanitizedOrg}_${Date.now()}`;
  const returnUrl = req.body && req.body.returnUrl ? String(req.body.returnUrl) : '';

  const sub = await cashfreeClient.createOnDemandSubscription({
    subscriptionId,
    customerName: req.body?.customerName || 'Admin User',
    customerEmail: req.body?.customerEmail || 'admin@aifleet.local',
    customerPhone: req.body?.customerPhone || '9999999999',
    planMaxAmountInr: req.body?.maxAmountInr || 100000,
    returnUrl,
  });

  res.json({
    orgId: caller.orgId,
    subscriptionId,
    subscriptionSessionId: sub.subscription_session_id || sub.cf_subscription_id || '',
    status: sub.subscription_status || 'INITIALIZED',
    cashfreeData: sub,
  });
}));

// --- Recharge orders: quote → provider order → intent -------------------------
//
// One code path for both gateways. It exists because the two things that made a
// recharge forgeable were both done per-gateway: the amount came from the request
// body, and nothing recorded what had been quoted. Here the quote is computed
// server-side from the subtotal, stored as an intent, and the provider is asked for
// the *gross* of that quote. `settle()` later refuses anything the intent does not
// corroborate, so neither the browser nor a webhook payload sets a price.

function resolveProvider(req, paymentInfo) {
  const requested = req.body && req.body.provider;
  if (requested != null && String(requested).trim() !== '') {
    const name = providers.normalizeProvider(requested);
    if (!name) {
      const err = new Error(`Unknown payment provider "${requested}". Supported: ${providers.PROVIDERS.join(', ')}.`);
      err.status = 400;
      err.code = 'unknown_provider';
      throw err;
    }
    return name;
  }
  return providers.normalizeProvider(paymentInfo && paymentInfo.provider) || 'cashfree';
}

function bonusExpiryFrom(value) {
  if (value == null || value === '') return {};
  const at = new Date(String(value));
  if (Number.isNaN(at.getTime())) {
    const err = new Error('bonusExpiresAt must be an ISO date/time.');
    err.status = 400;
    err.code = 'invalid_bonus_expiry';
    throw err;
  }
  return { promoExpiresAt: at.toISOString() };
}

async function createRechargeOrder(req, res, { provider: providerOverride } = {}) {
  const caller = resolveCallerOrg(req);
  if (!requireAdmin(caller, res)) return;

  const subtotal = parseRechargeSubtotal(req.body && req.body.amountInr);
  if (subtotal.error) return res.status(400).json({ error: subtotal.error, code: 'invalid_amount' });
  const coupon = parseCouponBps(req.body && req.body.couponBps);
  if (coupon.error) return res.status(400).json({ error: coupon.error, code: 'invalid_coupon' });

  const account = store.getBillingAccount(caller.orgId) || {};
  const paymentInfo = account.paymentInfo || {};
  const { quote, supplierStateCode: state, customerGstin, gstinIgnored } = quoteRecharge({
    subtotalPaise: subtotal.paise,
    couponBps: coupon.bps,
    paymentInfo,
  });
  const expiry = bonusExpiryFrom(req.body && req.body.bonusExpiresAt);
  const provider = providerOverride || resolveProvider(req, paymentInfo);
  const adapter = providers.providerFor(provider, { env: process.env });

  // Refuse before writing anything: an intent for a gateway this server cannot
  // talk to is a record of an order nobody can pay. The dev-only mock flag is the
  // same one settle() reads — a deployment must not be able to create mock orders
  // in one place and refuse them in the other.
  if (!adapter.isConfigured() && !allowsMockPayments()) {
    const err = new Error(`${adapter.name} is not configured on this server, so no payment can be collected. Add its keys, or set BILLING_ALLOW_MOCK_PAYMENTS=true for local development only.`);
    err.status = 400;
    err.code = 'provider_not_configured';
    throw err;
  }

  const orderId = newOrderId(caller.orgId);

  // The intent is written BEFORE the provider is called: an order that exists at
  // the gateway with no record here could be paid and then never credited, which
  // is a refund; the reverse (a record with no payment) settles into nothing.
  store.addRechargeIntent({
    orderId,
    orgId: caller.orgId,
    provider: adapter.name,
    status: 'QUOTED',
    subtotalPaise: quote.subtotalPaise,
    couponBps: coupon.bps,
    bonusPaise: quote.bonusPaise || 0,
    gstPaise: quote.gstPaise,
    totalPaise: quote.totalPaise,
    creditCount: moneyWire.paiseToCredits(quote.subtotalPaise),
    supplierStateCode: state,
    ...(customerGstin ? { customerGstin } : {}),
    ...expiry,
    // Recorded for the audit trail; deliberately NOT an input to the re-quote,
    // because `assumed` is what tells a human the split was guessed.
    placeOfSupply: quote.placeOfSupply,
    createdBy: caller.userId || caller.orgId,
  });

  let order;
  if (adapter.isConfigured()) {
    order = await adapter.createOrder({
      orderId,
      amountPaise: quote.totalPaise,
      customer: {
        id: `cust_${String(caller.orgId).replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        name: req.body?.customerName || paymentInfo.billingName || 'AI Fleet Org',
        email: req.body?.customerEmail || paymentInfo.billingEmail || 'billing@aifleet.local',
        phone: req.body?.customerPhone || paymentInfo.billingPhone || '',
      },
      returnUrl: req.body?.returnUrl || '',
      note: `AI Fleet wallet recharge for ${caller.orgId}`,
    });
  } else {
    // Local development with the mock flag on: the order is synthesized rather
    // than requested, because Cashfree's unconfigured client fabricates a
    // response and Razorpay's would call out with an empty key pair and come
    // back 401. `mode: 'mock'` is also what tells the UI to skip checkout and
    // call settle directly.
    order = { providerOrderId: null, checkout: { mode: 'mock', provider: adapter.name } };
  }
  if (order.providerOrderId && order.providerOrderId !== orderId) {
    store.updateRechargeIntent(orderId, { providerOrderId: order.providerOrderId });
  }

  res.json({
    orgId: caller.orgId,
    orderId,
    provider: adapter.name,
    // Which environment the checkout SDK must open against. The browser cannot
    // infer it (and guessing 'sandbox' is how a production payment gets pointed
    // at a test mode).
    environment: adapter.environment(),
    // The gross the gateway will charge, as the string the wire expects. The UI
    // must render `quote.totalInr`, never a number FlexPrice or the provider
    // echoes back — ₹590 is ours.
    amountInr: quoteView(quote).totalInr,
    quote: quoteView(quote),
    checkout: order.checkout,
    paymentSessionId: order.checkout.paymentSessionId || null,
    orderStatus: 'ACTIVE',
    ...(gstinIgnored ? { warnings: ['saved_tax_id_invalid'] } : {}),
  });
}

function settlementView(result) {
  return {
    success: true,
    orderId: result.orderId,
    orgId: result.orgId,
    provider: result.provider || null,
    status: result.status,
    alreadyProcessed: result.status === 'already_processed',
    orderStatus: 'PAID',
    creditsAdded: result.creditCount,
    bonusCredits: result.promoCredits || 0,
    balanceCredits: result.balanceCredits,
    subtotalInr: result.subtotalPaise == null ? null : moneyWire.decimalFromPaise(result.subtotalPaise),
    gstInr: result.gstPaise == null ? null : moneyWire.decimalFromPaise(result.gstPaise),
    totalInr: result.totalPaise == null ? null : moneyWire.decimalFromPaise(result.totalPaise),
    mock: Boolean(result.mock),
    settledAt: result.settledAt || null,
  };
}

// POST /api/billing/recharge/create-order — quote + persist + provider order.
// `provider` in the body picks the gateway; an org's saved preference is the default.
router.post('/recharge/create-order', asyncHandler((req, res) => createRechargeOrder(req, res)));

// POST /api/billing/recharge/settle — the browser's "I have paid" call.
router.post('/recharge/settle', asyncHandler(async (req, res) => {
  const caller = resolveCallerOrg(req);
  if (!requireAdmin(caller, res)) return;
  const orderId = String(req.body && req.body.orderId || '').trim();
  if (!orderId) return res.status(400).json({ error: 'orderId is required', code: 'missing_order_id' });
  const result = await settle({ orderId, orgId: caller.orgId, actor: caller.userId || 'recharge-settle-route' });
  res.json(settlementView(result));
}));

// POST /api/billing/cashfree/create-order — Cashfree-named alias of the above.
router.post('/cashfree/create-order', asyncHandler((req, res) => createRechargeOrder(req, res, { provider: 'cashfree' })));

// POST /api/billing/razorpay/create-order
router.post('/razorpay/create-order', asyncHandler((req, res) => createRechargeOrder(req, res, { provider: 'razorpay' })));

/**
 * POST /api/billing/razorpay/verify-order — check the checkout signature, then
 * settle. The signature proves the browser really completed that order; the
 * *amount* still comes from the server-side `verify()` inside settle, because a
 * signature over a client-chosen amount would prove nothing about the price.
 */
router.post('/razorpay/verify-order', asyncHandler(async (req, res) => {
  const caller = resolveCallerOrg(req);
  if (!requireAdmin(caller, res)) return;
  const orderId = String(req.body && req.body.orderId || '').trim();
  if (!orderId) return res.status(400).json({ error: 'orderId is required', code: 'missing_order_id' });

  const paymentId = String(req.body?.razorpayPaymentId || '').trim();
  const razorpayOrderId = String(req.body?.razorpayOrderId || '').trim();
  const signature = String(req.body?.razorpayPaymentSignature || '').trim();
  if (paymentId || razorpayOrderId || signature) {
    const adapter = providers.providerFor('razorpay', { env: process.env });
    if (!adapter.verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId: paymentId, signature })) {
      return res.status(400).json({
        error: 'That Razorpay payment signature does not match this order.',
        code: 'payment_signature_invalid',
      });
    }
  }
  const result = await settle({ orderId, orgId: caller.orgId, actor: caller.userId || 'razorpay-verify' });
  res.json(settlementView(result));
}));

// POST /api/billing/cashfree/verify-order — the browser's post-checkout call.
// Formerly this credited whatever org presented any `order_<org>_` id it could
// obtain, with the amount taken from Cashfree's response. Both are settle()'s now.
router.post('/cashfree/verify-order', asyncHandler(async (req, res) => {
  const caller = resolveCallerOrg(req);
  if (!requireAdmin(caller, res)) return;
  const orderId = String(req.body && req.body.orderId || '').trim();
  if (!orderId) return res.status(400).json({ error: 'orderId is required', code: 'missing_order_id' });
  const result = await settle({ orderId, orgId: caller.orgId, actor: caller.userId || 'cashfree-verify' });
  res.json(settlementView(result));
}));

// POST /api/billing/cashfree/verify-mandate — verify and associate Cashfree subscription mandate
router.post('/cashfree/verify-mandate', asyncHandler(async (req, res) => {
  const caller = resolveCallerOrg(req);
  if (!requireAdmin(caller, res)) return;

  const subscriptionId = String(req.body && req.body.subscriptionId || '').trim();
  if (!subscriptionId) {
    return res.status(400).json({ error: 'subscriptionId is required' });
  }

  const subDetails = await cashfreeClient.getSubscription(subscriptionId);
  const status = String(subDetails.subscription_status || '').toUpperCase();

  const account = store.getBillingAccount(caller.orgId);
  const existingAr = account?.autoRecharge || {};

  if (['ACTIVE', 'INITIALIZED', 'BANK_APPROVAL_PENDING'].includes(status)) {
    store.upsertBillingAccount(caller.orgId, {
      autoRecharge: {
        ...existingAr,
        cashfreeSubscriptionId: subscriptionId,
        paymentMethodType: subDetails.payment_method || existingAr.paymentMethodType || 'cashfree',
      },
    });
  }

  res.json({
    orgId: caller.orgId,
    subscriptionId,
    status,
    subDetails,
  });
}));

// POST /api/billing/cashfree/webhook — incoming Cashfree PG/subscription events
//
// The signature gate used to be `if (!isValid && NODE_ENV === 'production')`, i.e.
// it failed open everywhere else — which is where every test and every local stack
// runs. An unsigned `ORDER_PAID_SUCCESS` used to credit a wallet. Now an unsigned
// webhook is refused outright, and the one exception is the same dev-only flag
// settle() reads: without it, an unsigned event can do nothing here, and with it,
// it can only settle an order this server quoted and mocked.
router.post('/cashfree/webhook', asyncHandler(async (req, res) => {
  const rawBody = req.rawBody || JSON.stringify(req.body || {});
  const isValid = cashfreeClient.verifyWebhookSignature(req.headers, rawBody);
  const devMockAllowed = allowsMockPayments();

  if (!isValid && !devMockAllowed) {
    return res.status(401).json({ error: 'Invalid webhook signature', code: 'webhook_signature_invalid' });
  }
  if (!isValid) {
    log.warn('cashfree_webhook_signature_unverified', { reason: 'BILLING_ALLOW_MOCK_PAYMENTS is set (local development only)' });
  }

  const eventType = req.body && req.body.type;
  const data = (req.body && req.body.data) || {};

  if (eventType === 'SUBSCRIPTION_AUTH_STATUS' || eventType === 'SUBSCRIPTION_STATUS_CHANGED') {
    const subId = data.subscription && data.subscription.subscription_id;
    const status = data.subscription && data.subscription.subscription_status;
    if (subId && status === 'ACTIVE') {
      for (const acc of store.listBillingAccounts()) {
        if (acc.autoRecharge && acc.autoRecharge.cashfreeSubscriptionId === subId) {
          store.upsertBillingAccount(acc.id, {
            autoRecharge: { ...acc.autoRecharge, status: 'ACTIVE' },
          });
        }
      }
    }
  } else if (eventType === 'SUBSCRIPTION_PAYMENT_SUCCESS') {
    // Mandate-driven auto-recharge. This is the one credit path that does not yet
    // run through settle() — it has no quote and therefore no intent, because the
    // amount comes from the mandate threshold, not from a user entering ₹500. It
    // keeps the ledger for now (its spine is a Phase 6 item), but it no longer
    // double-credits a replayed event and no longer converts rupees with floats.
    const subId = data.subscription && data.subscription.subscription_id;
    const payment = data.payment || {};
    const paymentId = payment.payment_id;
    const amountPaise = payment.payment_amount == null ? NaN : moneyWire.paiseFromDecimal(String(payment.payment_amount));
    if (subId && paymentId && Number.isSafeInteger(amountPaise) && amountPaise > 0) {
      for (const acc of store.listBillingAccounts()) {
        if (acc.autoRecharge && acc.autoRecharge.cashfreeSubscriptionId === subId) {
          const already = store.listLedgerEntries({ orgId: acc.id })
            .find((e) => e.meta && e.meta.cashfreePaymentId === paymentId);
          if (already) continue;
          ledger.postEntry(acc.id, {
            type: 'recharge',
            amountPaise,
            description: `Auto-recharge webhook payment (${paymentId})`,
            meta: { cashfreeSubscriptionId: subId, cashfreePaymentId: paymentId, paymentId },
          });
        }
      }
    }
  } else if (eventType === 'ORDER_PAID_SUCCESS' || eventType === 'PAYMENT_SUCCESS_WEBHOOK') {
    // The event names the order; it does not price it. settle() looks the intent up
    // by that id, re-verifies the amount against the gateway, and credits the org
    // that owns the intent — which is why the old prefix scan over every account
    // (`order_<org>_` matched against a caller-supplied string) is gone rather than
    // fixed.
    const order = data.order || {};
    const orderId = order.order_id || (data.payment && data.payment.order_id);
    if (orderId && store.getRechargeIntent(orderId)) {
      try {
        const result = await settle({ orderId, actor: 'cashfree-webhook' });
        log.info('cashfree_webhook_settled', { orderId, status: result.status });
      } catch (err) {
        // A 5xx here is deliberate: a transient FlexPrice outage must make Cashfree
        // retry, whereas a 200 acknowledges an event that credited nothing.
        if (err && (err.code === 'intent_not_found' || err.status === 403)) {
          log.warn('cashfree_webhook_refused', { orderId, code: err.code });
        } else {
          throw err;
        }
      }
    } else {
      log.warn('cashfree_webhook_no_intent', { orderId: orderId || null });
    }
  }

  res.json({ status: 'ok' });
}));

// POST /api/billing/razorpay/webhook — `payment.captured` / `order.paid`
//
// Same shape as the Cashfree one and for the same reason: the event carries an
// order id, never an authority to price it. RAZORPAY_WEBHOOK_SECRET is required —
// there is no dev bypass here, because unlike Cashfree's sandbox mock, an unsigned
// Razorpay event is simply an unauthenticated request to a credit path.
router.post('/razorpay/webhook', asyncHandler(async (req, res) => {
  const rawBody = req.rawBody || JSON.stringify(req.body || {});
  const adapter = providers.providerFor('razorpay', { env: process.env });
  const event = adapter.parseWebhook(rawBody, req.headers);
  if (!event.verified) {
    return res.status(401).json({ error: 'Invalid webhook signature', code: 'webhook_signature_invalid' });
  }
  if (event.event === 'ORDER_PAID_SUCCESS' && event.orderId && store.getRechargeIntent(event.orderId)) {
    const result = await settle({ orderId: event.orderId, actor: 'razorpay-webhook' });
    log.info('razorpay_webhook_settled', { orderId: event.orderId, status: result.status });
  }
  res.json({ status: 'ok' });
}));

module.exports = router;
module.exports.resolveCallerOrg = resolveCallerOrg;
module.exports.scopedUsageRecords = scopedUsageRecords;
module.exports.bySourceWindow = bySourceWindow;
