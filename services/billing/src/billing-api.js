'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { CONFIG } = require('@software-factory/shared-core/config');
const { asyncHandler } = require('@software-factory/shared-core/util');
const log = require('@software-factory/shared-core/logger');
const store = require('@software-factory/shared-core/store');
const ledger = require('@software-factory/shared-core/billing/ledger');
const gate = require('@software-factory/shared-core/billing/gate');
const { paiseToInr } = require('@software-factory/shared-core/billing/pricing');
const { SHARED_ORG_ID } = require('@software-factory/shared-core/billing/org-context');
const cashfreeClient = require('@software-factory/shared-core/billing/cashfree-client');
const creditRates = require('@software-factory/shared-core/billing/credit-rates');
const gst = require('@software-factory/shared-core/billing/gst');
const moneyWire = require('@software-factory/shared-core/billing/money-wire');
const providers = require('./payment-providers');
const { settle, allowsMockPayments } = require('./recharge-settle');
const { createFlexpriceReadsRouter } = require('./flexprice-reads');

/**
 * Cost-monitoring + billing API. Billing state lives in the shared JS store;
 * org/project/user *names* come from the usage records.
 *
 * CROSS-TENANT ISOLATION (critical): the gateway resolves the caller's billing
 * org + admin flag SERVER-SIDE from the org service and forwards them as the
 * `x-ai-fleet-billing-*` headers below. Those headers are honored only behind a
 * proof that the request came from the gateway — `INTERNAL_API_TOKEN` in direct
 * mode, an ID token from `BILLING_TRUSTED_SERVICE_ACCOUNTS` in cloud mode, or the
 * loopback development profile (`trusted-caller.js`). Without one, `resolveCallerOrg`
 * answers with this deployment's own org, so an unauthenticated peer cannot name a
 * tenant at all: isolation is a property of this endpoint, not only of the network
 * in front of it. Every read scopes to that org, and mutations additionally
 * require org-admin (re-checked here, not only at the edge). On the shared
 * free-tier account (SHARED_ORG_ID) the per-project/user drill-down is
 * additionally scoped to the caller's own user so personal tenants can't see
 * each other's project names. Money is integer paise internally; INR is exposed
 * only for display.
 */

const router = express.Router();

// The read-only FlexPrice surface for the Usage page. Built here rather than
// required as a ready router so `resolveCallerOrg` — the one trusted source of the
// caller's org — is injected instead of re-implemented a second time.
const flexpriceReads = createFlexpriceReadsRouter({ resolveCallerOrg });

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS = Object.freeze({ day: 1, week: 7, month: 30 });
const MAX_AUTO_RECHARGE_PAISE = 100000000; // ₹1,000,000 sanity cap on a scheduled reload amount

const { callerOf } = require('./trusted-caller');

/**
 * Credits in, integer token credits out — on the digits, via `money-wire`. The
 * previous `Math.round(Number(x) * 100)` was exact for the values a UI form sends and
 * wrong for the ones a script sends (1.005 → 101 in some orders, 100 in others).
 * Anything unparseable is NaN, which every caller already rejects.
 *
 * Named for credits and not rupees because that is what a form field now says: this
 * server stopped offering a ₹-labelled balance input when the display went
 * credits-only. `1 credit = ₹1 = 100 token credits` (D6), so the arithmetic is the
 * old one and only the unit word moved.
 */
function creditsToTokenCredits(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return NaN;
  try {
    return moneyWire.tokenCreditsFromCredits(text);
  } catch (_) {
    return NaN;
  }
}

/** Token credits → the decimal string of whole credits a customer reads. Unknown stays `null`. */
function creditsOf(tokenCredits) {
  const raw = Number(tokenCredits);
  if (tokenCredits === null || tokenCredits === undefined || !Number.isFinite(raw)) return null;
  return moneyWire.creditsFromTokenCredits(Math.round(raw));
}

/**
 * The admin-only ₹ column, added to a spend row only when the caller is an admin.
 *
 * Rupees stay on the usage routes for one reader: an admin reconciling a run against a
 * provider bill or a GST invoice needs the ₹ the card paid, and a customer needs none
 * of it. The presence of the key IS the gate — a view never has to decide whether it is
 * allowed to print money it was not sent, because it was not sent.
 */
function rupeeFields(isAdmin, costTokenCredits, notionalTokenCredits) {
  if (!isAdmin) return {};
  return { costInr: paiseToInr(costTokenCredits), notionalInr: paiseToInr(notionalTokenCredits) };
}

/**
 * A recharge is one of the card's packages, and the client chooses nothing else.
 *
 * A typed amount made the price a request field: the server re-derived tax from it,
 * but the offer itself came from the browser. `packageId` names a row of
 * `deploy/billing/credit-rates.yaml`, so the card is the only author of a price, and
 * the bonus (which is money we give away) stops being a `couponBps` anyone can send.
 * `bonusExpiresAt` joins them: the package states its own validity window, so a
 * client-extended promo expiry is as much a price input as a coupon.
 *
 * An old SPA bundle that keeps posting `amountInr` gets a 400 rather than a silent
 * misread. A purchase is not a place to guess what someone meant.
 */
function rejectCustomAmount(body = {}) {
  const sent = ['amountInr', 'couponBps', 'bonusExpiresAt']
    .filter((field) => body[field] != null && String(body[field]).trim() !== '');
  if (!sent.length) return {};
  return {
    status: 400,
    code: 'amount_not_accepted',
    error: `Recharges are fixed packages, so ${sent.join(', ')} ${sent.length > 1 ? 'are' : 'is'} not accepted. Send a packageId from GET /api/billing/summary.`,
  };
}

function parsePackageId(value) {
  const id = String(value == null ? '' : value).trim();
  if (!id) {
    return { status: 400, code: 'missing_package_id', error: 'packageId is required: pick one of the offered credit packages.' };
  }
  let pkg;
  try {
    pkg = creditRates.packageById(id);
  } catch (err) {
    // The card is baked into the image and gated at boot, so this is a broken
    // deployment, not a bad request. Loud and typed, never a default package.
    return { status: 503, code: err.code || 'rate_card_missing', error: `No credit package can be quoted: ${err.message}` };
  }
  if (!pkg) return { status: 400, code: 'unknown_package', error: `Unknown credit package "${id}".` };
  // Retirement stops a NEW order; it never revives one that was already paid for,
  // which is why settle() looks the package up by its frozen numbers and not here.
  if (!pkg.enabled) return { status: 400, code: 'package_retired', error: `Credit package "${id}" is no longer offered.` };
  return { pkg };
}

/** What the purchase panel renders: the credit offer, plus the rupee price beside it. */
function packageView(pkg) {
  return {
    packageId: pkg.id,
    priceInr: pkg.priceInr,
    credits: pkg.credits,
    prepaidCredits: pkg.prepaidCredits,
    bonusCredits: pkg.bonusCredits,
    bonusValidDays: pkg.bonusValidDays,
  };
}

/** The card's offers, or none: a card this image cannot read must not blank the cost page. */
function offeredPackages() {
  try {
    return creditRates.listPackages().map(packageView);
  } catch (err) {
    log.warn(`billing_packages_unavailable: ${err.message}`);
    return [];
  }
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

/** What the browser is shown: the ₹ it will pay, and the credits that arrive for it. */
function quoteView(quote) {
  const bonusTokenCredits = quote.bonusTokenCredits || 0;
  return {
    // Rupee-side: what a card is charged and what a GST invoice states.
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
    // Credit-side: what the wallet gains. Never the taxed total — that is the whole
    // point of splitting these two columns on one screen.
    prepaidCredits: moneyWire.tokenCreditsToCredits(quote.subtotalPaise),
    bonusTokenCredits,
    bonusCredits: moneyWire.creditsFromTokenCredits(bonusTokenCredits),
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
 * context — which is only read when the request PROVED it came from the gateway
 * (`trusted-caller.js`). Absent that proof the headers are ignored and the
 * deployment's own org answers with no admin rights, so a direct caller reads the
 * tenant it belongs to and can neither name another nor mutate it.
 */
function resolveCallerOrg(req) {
  return callerOf(req);
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
  const costTokenCredits = scoped.reduce((s, r) => s + (Number(r.costTokenCredits) || 0), 0);
  const tokens = scoped.reduce((s, r) => s + ((r.usage && Number(r.usage.totalTokens)) || 0), 0);
  // Money the platform routed but never paid. Reported next to the charge, not
  // inside it: an org that brought its own key must see the value it consumed and
  // a zero that it can verify against its own provider invoice.
  const notionalTokenCredits = scoped.reduce((s, r) => s + (Number(r.notionalCostTokenCredits) || 0), 0);
  return {
    runs: scoped.length,
    tokens,
    costTokenCredits,
    notionalTokenCredits,
    costCredits: creditsOf(costTokenCredits),
    notionalCredits: creditsOf(notionalTokenCredits),
  };
}

/**
 * The same window split by which key paid the provider. A record with no
 * `billingSource` predates BYOK metering, and only a platform key was reachable
 * then, so it belongs with `managed`.
 */
/** One empty spend bucket; both series start at zero rather than at absent. */
function newSourceBucket() {
  return { runs: 0, tokens: 0, costTokenCredits: 0, notionalTokenCredits: 0 };
}

function bySourceWindow(records, days, now) {
  const cutoff = new Date(now - days * DAY_MS).toISOString();
  const scoped = records.filter((r) => String(r.createdAt || '') >= cutoff);
  // Both series always present, even at zero: the visible zero is the BYOK value
  // proposition, and a missing key would render as "no data" instead.
  const sources = { managed: newSourceBucket(), customer: newSourceBucket() };
  for (const r of scoped) {
    const source = r.billingSource || 'managed';
    const acc = sources[source] || { runs: 0, tokens: 0, costTokenCredits: 0, notionalTokenCredits: 0 };
    acc.runs += 1;
    acc.tokens += (r.usage && Number(r.usage.totalTokens)) || 0;
    acc.costTokenCredits += Number(r.costTokenCredits) || 0;
    acc.notionalTokenCredits += Number(r.notionalCostTokenCredits) || 0;
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
      costCredits: creditsOf(acc.costTokenCredits),
      notionalCredits: creditsOf(acc.notionalTokenCredits),
    }])),
  };
}

function requireAdmin(caller, res) {
  if (caller.isAdmin) return true;
  res.status(403).json({ error: 'Organization admin permission is required.', code: 'access_denied' });
  return false;
}

// GET /api/billing/summary — the wallet balance + period spend + config for the caller's org.
//
// The balance is the gate's number, read here rather than served from cache: this
// is the page a customer looks at when money has just moved, and `BILLING_GATE_TTL_MS`
// of "still ₹0" after a recharge is not an acceptable answer. `fundState` is the
// gate's four-value verdict and the UI renders from IT rather than from a
// comparison against zero, because `unknown` (no wallet, or a read that failed)
// must not be drawn as "exhausted" any more than a negative balance is drawn as
// "available".
router.get('/summary', asyncHandler(async (req, res) => {
  const caller = resolveCallerOrg(req);
  const account = store.getBillingAccount(caller.orgId);
  const fund = await gate.ensureFundStatus(caller.orgId);
  const balanceTokenCredits = fund.balanceTokenCredits;
  const records = scopedUsageRecords(caller);
  const now = Date.now();
  res.json({
    orgId: caller.orgId,
    isAdmin: caller.isAdmin,
    // Every money-shaped number below is in credits. `unit` rather than `currency`
    // because there is no currency here: a wallet balance is not a rupee amount, and
    // the rupee figures a customer does see (the checkout total, the GST invoice) ride
    // on the quote and settlement payloads, spelled `…Inr`.
    unit: 'credits',
    balanceCredits: creditsOf(balanceTokenCredits),
    balanceTokenCredits,
    fundsAvailable: fund.fundsAvailable,
    fundStatus: fund.fundStatus,
    fundState: fund.state,
    gatePolicy: fund.gatePolicy,
    balanceStale: Boolean(fund.stale),
    sandboxCreationDisabled: fund.sandboxCreationDisabled,
    scheduledCallsDisabled: fund.scheduledCallsDisabled,
    // The credit value of the free-tier opening grant, i.e. what the provisioner
    // minted as FREE_CREDIT_GRANT. Configuration, not a balance — the balance
    // above is the only spendable number on this page.
    initialCreditCredits: creditsOf((account && account.initialCreditTokenCredits)
      || CONFIG.BILLING.initialCreditTokenCredits),
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
    alertThresholdsCredits: (account && account.alertThresholdsTokenCredits ? account.alertThresholdsTokenCredits : []).map(creditsOf),
    // What may be bought, straight from the rate card. The browser composes no
    // amount and picks no coupon: this list is the only way it learns a price exists.
    // `rechargePackages`, not `packages`: the Usage page also renders
    // `overview.packages`, which are credit balances FlexPrice already holds an expiry
    // for. One word for "what you can buy" and "what you own" on one screen is how a
    // panel ends up offering a wallet row as a checkout.
    rechargePackages: offeredPackages(),
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
          thresholdCredits: creditsOf(account.autoRecharge.thresholdTokenCredits),
          thresholdPercent: account.autoRecharge.thresholdPercent || 20,
          // Stored as `amountPaise` because it is the charge a mandate settles, not a
          // balance; reported as credits because 1 credit = ₹1 (D6) and this page speaks
          // credits. The integer is the same number either way.
          amountCredits: creditsOf(account.autoRecharge.amountPaise),
          cashfreeSubscriptionId: account.autoRecharge.cashfreeSubscriptionId || null,
          paymentMethodType: account.autoRecharge.paymentMethodType || null,
          cashfreeConfigured: cashfreeClient.isConfigured(),
        }
      : {
          enabled: false,
          mode: 'amount',
          thresholdCredits: null,
          thresholdPercent: 20,
          amountCredits: null,
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
      key, label, runs: 0, tokens: 0, costTokenCredits: 0, notionalTokenCredits: 0,
    };
    g.runs += 1;
    g.tokens += (r.usage && Number(r.usage.totalTokens)) || 0;
    g.costTokenCredits += Number(r.costTokenCredits) || 0;
    g.notionalTokenCredits += Number(r.notionalCostTokenCredits) || 0;
    groups.set(key, g);
  }
  const rows = [...groups.values()]
    .sort((a, b) => (b.costTokenCredits + b.notionalTokenCredits) - (a.costTokenCredits + a.notionalTokenCredits))
    .map((g) => ({
      key: g.key,
      label: g.label,
      runs: g.runs,
      tokens: g.tokens,
      costCredits: creditsOf(g.costTokenCredits),
      notionalCredits: creditsOf(g.notionalTokenCredits),
      ...rupeeFields(caller.isAdmin, g.costTokenCredits, g.notionalTokenCredits),
    }));
  const totalsTokenCredits = records.reduce((s, r) => s + (Number(r.costTokenCredits) || 0), 0);
  const totalsNotionalTokenCredits = records.reduce((s, r) => s + (Number(r.notionalCostTokenCredits) || 0), 0);
  res.json({
    orgId: caller.orgId,
    groupBy,
    period,
    unit: 'credits',
    rows,
    totals: {
      runs: rows.reduce((s, r) => s + r.runs, 0),
      tokens: rows.reduce((s, r) => s + r.tokens, 0),
      costCredits: creditsOf(totalsTokenCredits),
      notionalCredits: creditsOf(totalsNotionalTokenCredits),
      ...rupeeFields(caller.isAdmin, totalsTokenCredits, totalsNotionalTokenCredits),
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
      costCredits: creditsOf(r.costTokenCredits),
      notionalCredits: creditsOf(r.notionalCostTokenCredits),
      ...rupeeFields(caller.isAdmin, r.costTokenCredits, r.notionalCostTokenCredits),
      // Each row explains its own zero, so a per-run dispute needs no join.
      billingSource: r.billingSource || 'managed',
      traceId: r.traceId || null,
      runId: r.runId || null,
    }));
  res.json({ orgId: caller.orgId, taskId, unit: 'credits', records });
}));

// POST /api/billing/recharge { packageId } — the GST quote for one package ONLY.
//
// It credits nothing. Before this route's predecessor, POST /recharge moved money
// straight into the org's balance with no payment behind it at all; the credit now
// lives in `recharge-settle.js` and can only be reached by an order the provider
// confirms. What remains here is the breakdown the customer must see before paying:
// ₹2,000 + CGST ₹180 + SGST ₹180 = ₹2,360, for 3,500 credits.
router.post('/recharge', asyncHandler(async (req, res) => {
  const caller = resolveCallerOrg(req);
  if (!requireAdmin(caller, res)) return;

  const rejected = rejectCustomAmount(req.body || {});
  if (rejected.error) return res.status(rejected.status).json({ error: rejected.error, code: rejected.code });
  const chosen = parsePackageId(req.body && req.body.packageId);
  if (chosen.error) return res.status(chosen.status).json({ error: chosen.error, code: chosen.code });
  const pkg = chosen.pkg;

  const account = store.getBillingAccount(caller.orgId);
  const { quote, gstinIgnored } = quoteRecharge({
    subtotalPaise: pkg.subtotalPaise,
    couponBps: pkg.couponBps,
    paymentInfo: (account && account.paymentInfo) || {},
  });
  res.json({
    orgId: caller.orgId,
    package: packageView(pkg),
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

  // A balance threshold is a credit figure now. An old bundle that still posts `…Inr`
  // would not be ignored here: `autoRecharge` is rewritten wholesale, so a threshold
  // that arrives under the old name is a threshold that arrives as 0 — the alert and the
  // auto-reload silently off. A purchase is not the only place this server refuses to
  // guess what a request meant.
  const staleUnit = [];
  if (body.alertThresholdsInr != null) staleUnit.push('alertThresholdsInr');
  if (body.autoRecharge && typeof body.autoRecharge === 'object') {
    for (const field of ['thresholdInr', 'amountInr']) {
      if (body.autoRecharge[field] != null) staleUnit.push(`autoRecharge.${field}`);
    }
  }
  if (staleUnit.length) {
    return res.status(400).json({
      error: `Billing thresholds are configured in credits, not rupees: send alertThresholdsCredits / autoRecharge.thresholdCredits / autoRecharge.amountCredits. Received ${staleUnit.join(', ')}.`,
      code: 'unit_not_accepted',
    });
  }

  if (Array.isArray(body.alertThresholdsCredits)) {
    const thresholds = body.alertThresholdsCredits
      .map(creditsToTokenCredits)
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a);
    patch.alertThresholdsTokenCredits = thresholds;
    patch.lastAlertedThresholdTokenCredits = null; // re-arm on a threshold change
  }
  if (body.autoRecharge && typeof body.autoRecharge === 'object') {
    const ar = body.autoRecharge;
    const existingAccount = store.getBillingAccount(caller.orgId);
    const existingAr = (existingAccount && existingAccount.autoRecharge) || {};

    const mode = ['amount', 'percentage'].includes(ar.mode) ? ar.mode : 'amount';
    const thresholdTokenCredits = creditsToTokenCredits(ar.thresholdCredits);
    const amountPaise = creditsToTokenCredits(ar.amountCredits);
    const thresholdPercent = Number.isFinite(Number(ar.thresholdPercent)) ? Math.max(1, Math.min(100, Number(ar.thresholdPercent))) : 20;

    // The reload choice is a package like every other recharge, so an id is validated
    // against the card here instead of being filed for later. It is deliberately NOT
    // read by `auto-recharge-job.js`, which settles nothing today: storing an offer the
    // job cannot honor is honest only as long as nothing claims it is honored.
    let packageId = String(existingAr.packageId || '');
    if (ar.packageId !== undefined) {
      const wanted = String(ar.packageId || '').trim();
      if (!wanted) packageId = '';
      else {
        const chosen = parsePackageId(wanted);
        if (chosen.error) return res.status(chosen.status).json({ error: chosen.error, code: chosen.code });
        packageId = chosen.pkg.id;
      }
    }

    patch.autoRecharge = {
      ...existingAr,
      enabled: Boolean(ar.enabled),
      mode,
      thresholdTokenCredits: Number.isFinite(thresholdTokenCredits) ? thresholdTokenCredits : 0,
      thresholdPercent,
      amountPaise: Number.isFinite(amountPaise) && amountPaise > 0 ? Math.min(amountPaise, MAX_AUTO_RECHARGE_PAISE) : 0,
      packageId,
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
    unit: 'credits',
    alertThresholdsCredits: (account.alertThresholdsTokenCredits || []).map(creditsOf),
    paymentInfo: account.paymentInfo || null,
    autoRecharge: {
      enabled: Boolean(account.autoRecharge && account.autoRecharge.enabled),
      mode: account.autoRecharge && account.autoRecharge.mode || 'amount',
      thresholdCredits: creditsOf(account.autoRecharge && account.autoRecharge.thresholdTokenCredits),
      thresholdPercent: account.autoRecharge && account.autoRecharge.thresholdPercent || 20,
      amountCredits: creditsOf(account.autoRecharge && account.autoRecharge.amountPaise),
      packageId: (account.autoRecharge && account.autoRecharge.packageId) || null,
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

/**
 * The bonus wallet's deadline, counted from the order that earned it: the package
 * states its own validity window, so this is card data on an intent, never a value
 * the browser sent. Each package gets its own because a bonus granted for a
 * ₹2,000 package and one granted for ₹4,000 expire on different clocks.
 */
function bonusExpiryFrom(pkg, from = Date.now()) {
  return { promoExpiresAt: new Date(from + pkg.bonusValidDays * DAY_MS).toISOString() };
}

async function createRechargeOrder(req, res, { provider: providerOverride } = {}) {
  const caller = resolveCallerOrg(req);
  if (!requireAdmin(caller, res)) return;

  const rejected = rejectCustomAmount(req.body || {});
  if (rejected.error) return res.status(rejected.status).json({ error: rejected.error, code: rejected.code });
  // A quote is not a reservation: create-order resolves the id against the card
  // itself, so a package retired between the two calls is refused here.
  const chosen = parsePackageId(req.body && req.body.packageId);
  if (chosen.error) return res.status(chosen.status).json({ error: chosen.error, code: chosen.code });
  const pkg = chosen.pkg;

  const account = store.getBillingAccount(caller.orgId) || {};
  const paymentInfo = account.paymentInfo || {};
  const { quote, supplierStateCode: state, customerGstin, gstinIgnored } = quoteRecharge({
    subtotalPaise: pkg.subtotalPaise,
    couponBps: pkg.couponBps,
    paymentInfo,
  });
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
  //
  // It carries the whole offer, not a reference to the card: `settle()` re-derives
  // the tax from these fields and never reads `credit-rates.yaml`, so editing or
  // retiring the package between paying and settling cannot reprice an order that
  // was already collected. `store.updateRechargeIntent` freezes every one of them.
  store.addRechargeIntent({
    orderId,
    orgId: caller.orgId,
    provider: adapter.name,
    status: 'QUOTED',
    packageId: pkg.id,
    bonusValidDays: pkg.bonusValidDays,
    subtotalPaise: quote.subtotalPaise,
    couponBps: pkg.couponBps,
    bonusTokenCredits: quote.bonusTokenCredits || 0,
    gstPaise: quote.gstPaise,
    totalPaise: quote.totalPaise,
    creditCount: moneyWire.tokenCreditsToCredits(quote.subtotalPaise),
    supplierStateCode: state,
    ...(customerGstin ? { customerGstin } : {}),
    // The customer state that decided CGST/SGST versus IGST, but only when it was a
    // fact rather than the supplier-state default. `requote` feeds this back into
    // `gst.quote`, and freezing it closes a hole `quote_drift` cannot see: an
    // interstate swap leaves `totalPaise` byte-identical while rewriting the split on
    // money that has already been collected and filed.
    ...(!quote.placeOfSupply.assumed ? { customerStateCode: quote.placeOfSupply.stateCode } : {}),
    ...bonusExpiryFrom(pkg),
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
        name: req.body?.customerName || paymentInfo.billingName || 'Software Factory Org',
        email: req.body?.customerEmail || paymentInfo.billingEmail || 'billing@aifleet.local',
        phone: req.body?.customerPhone || paymentInfo.billingPhone || '',
      },
      returnUrl: req.body?.returnUrl || '',
      note: `Software Factory wallet recharge for ${caller.orgId}`,
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
    // echoes back — ₹2,360 is ours. Named `payable` and not `amountInr` because
    // `amountInr` is now a request field this endpoint refuses, and one word that
    // means "the org's price" on the way in and "our price" on the way out is how a
    // stale bundle buys the wrong thing.
    payableInr: quoteView(quote).totalInr,
    package: packageView(pkg),
    quote: quoteView(quote),
    checkout: order.checkout,
    paymentSessionId: order.checkout.paymentSessionId || null,
    orderStatus: 'ACTIVE',
    ...(gstinIgnored ? { warnings: ['saved_tax_id_invalid'] } : {}),
  });
}

/**
 * The settlement receipt. Credits are the money the org has; the ₹ fields are
 * labelled for what they are — a payment and a tax — because a number on this
 * screen that reads like a balance is a number someone will spend twice.
 */
function settlementView(result) {
  const bonusCredits = result.promoCredits || 0;
  return {
    success: true,
    orderId: result.orderId,
    orgId: result.orgId,
    provider: result.provider || null,
    status: result.status,
    alreadyProcessed: result.status === 'already_processed',
    orderStatus: 'PAID',
    packageId: result.packageId || null,
    creditsAdded: result.creditCount,
    bonusCredits,
    // 'expired' when the bonus window closed between paying and settling: the prepaid
    // credit landed, the offer did not, and the screen has to say which.
    bonusSkipped: result.bonusSkipped || null,
    bonusExpiresAt: result.promoExpiresAt || null,
    totalCredits: (result.creditCount || 0) + bonusCredits,
    balanceCredits: result.balanceCredits,
    taxableInr: result.subtotalPaise == null ? null : moneyWire.decimalFromPaise(result.subtotalPaise),
    gstInr: result.gstPaise == null ? null : moneyWire.decimalFromPaise(result.gstPaise),
    payableInr: result.totalPaise == null ? null : moneyWire.decimalFromPaise(result.totalPaise),
    mock: Boolean(result.mock),
    settledAt: result.settledAt || null,
  };
}

/**
 * Settle, then drop what the FlexPrice read routes cached for that org.
 *
 * `settle()` invalidates the admission gate itself (`recharge-settle.js:378`);
 * these routes keep their own wallet lookup and last-known-view caches, so a
 * recharge that leaves the Usage page showing the pre-payment numbers for a TTL
 * is indistinguishable from a recharge that did not land.
 */
async function settleAndRefresh(callSpec) {
  const result = await settle(callSpec);
  flexpriceReads.invalidate(result && result.orgId);
  return result;
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
  const result = await settleAndRefresh({ orderId, orgId: caller.orgId, actor: caller.userId || 'recharge-settle-route' });
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
  const result = await settleAndRefresh({ orderId, orgId: caller.orgId, actor: caller.userId || 'razorpay-verify' });
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
  const result = await settleAndRefresh({ orderId, orgId: caller.orgId, actor: caller.userId || 'cashfree-verify' });
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
    // Mandate-driven auto-recharge. It credits NOTHING, and that is the point
    // rather than an oversight: the only amount authority this service accepts is
    // a quoted intent, and a mandate payment has none — the amount came from the
    // subscription, not from a quote anyone agreed to. Crediting a wallet from
    // `payment.payment_amount` is the same hole the one-time path had before
    // `settle()` closed it, one field name wider.
    //
    // The job that USED to initiate these charges no longer does, so an event
    // here means a mandate was charged outside this repo (Cashfree's own schedule,
    // or a subscription minted before the local-balance path was removed). Loud on
    // purpose: money arrived and no credit was applied, which is a reconciliation
    // the operator has to see, not a success line in a log.
    const subId = data.subscription && data.subscription.subscription_id;
    const payment = data.payment || {};
    let amountPaise = null;
    try {
      if (payment.payment_amount != null) {
        amountPaise = moneyWire.paiseFromDecimal(String(payment.payment_amount));
      }
    } catch (_) {
      // An amount this server cannot read is reported as unreadable, not as zero,
      // and it does not stop the log line: the payment happened either way.
    }
    log.error('cashfree_mandate_payment_unsettled', {
      cashfreeSubscriptionId: subId || null,
      cashfreePaymentId: payment.payment_id || null,
      paymentAmountPaise: Number.isSafeInteger(amountPaise) ? amountPaise : null,
      note: 'a mandate was charged without a quoted intent, so no credits were added; reconcile this payment and grant the credits in FlexPrice',
    });
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
        const result = await settleAndRefresh({ orderId, actor: 'cashfree-webhook' });
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
    const result = await settleAndRefresh({ orderId: event.orderId, actor: 'razorpay-webhook' });
    log.info('razorpay_webhook_settled', { orderId: event.orderId, status: result.status });
  }
  res.json({ status: 'ok' });
}));

// GET /api/billing/flexprice/* — the Usage page's read surface (overview,
// heatmap, trend, log). Read-only, org-resolved server-side, display values only;
// see services/billing/src/flexprice-reads.js for why the isolation lives there.
router.use('/flexprice', flexpriceReads);

module.exports = router;
module.exports.resolveCallerOrg = resolveCallerOrg;
module.exports.scopedUsageRecords = scopedUsageRecords;
module.exports.bySourceWindow = bySourceWindow;
module.exports.flexpriceReads = flexpriceReads;
