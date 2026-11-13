'use strict';

const store = require('../store');
const log = require('../logger');
const { CONFIG } = require('../config');
const { resolveOrgId, SHARED_ORG_ID } = require('./org-context');
const { paiseFromCredits } = require('./money-wire');
const { createFlexpriceClient, rowsOf } = require('./flexprice-client');

/**
 * Organization-level admission: may this org start another run?
 *
 * The number it asks about is FlexPrice's — `real_time_credit_balance` from
 * `GET /v1/wallets/:id/balance/real-time`, the projection that moves as usage
 * accrues. The STORED wallet balance does not (measured, docs/FLEXPRICE_FINDINGS.md
 * §2: an org can consume all day and still read a full prepaid balance until an
 * invoice finalizes), and the first-party ledger balance this function used to
 * read was a third number that agreed with neither.
 *
 * Three states, because two is not enough. A positive balance runs; a zero
 * balance is exhausted; a NEGATIVE balance is a different event — only
 * `MANUAL_BALANCE_DEBIT` can produce one, because it is the one write that
 * bypasses the insufficient-balance check (measured: −2900 credits, HTTP 200). An
 * org in the negative has been charged for something it did not pay for, so it
 * reads as its own `fundStatus` rather than being clamped to "out of credit".
 *
 * Every call site is synchronous — 8 sites in 6 modules plus the admission checks
 * in the gateway and the planner — while the balance is a network read. So the
 * answer comes from a stale-while-revalidate cache and the refresh happens in the
 * background: measured p50 5 ms / p95 17 ms on a warm stack means a fetch per
 * call site is a per-run tax of up to ~50 ms with no extra correctness. The
 * refresh is single-flight per org, so a burst of admissions is ONE read.
 */

const STATE = Object.freeze({
  available: 'available',
  exhausted: 'exhausted',
  negative: 'negative',
  unknown: 'unknown',
});

// Shorter than the drain tick, longer than a run's admission sequence: one run
// should not see the balance change underneath it, and a recharge should unblock
// within a tick rather than a minute.
const DEFAULT_TTL_MS = 15000;
// After a failed read, the previous view is kept and retried no sooner than this.
// Without it, an outage turns every admission into a request.
const ERROR_RETRY_MS = 5000;

const views = new Map();
const inflight = new Map();
// Orgs already reported as "gate on, balance never read". Once each, because the
// condition is per process start, not per admission.
const reportedUnknown = new Set();
let policyReported = null;

function ttlMs(deps = {}) {
  if (Number.isFinite(deps.ttlMs)) return deps.ttlMs;
  return Number.isFinite(CONFIG.BILLING.gateTtlMs) ? CONFIG.BILLING.gateTtlMs : DEFAULT_TTL_MS;
}

/**
 * `'off'` must be named. The default follows the money source: enforcement needs
 * a wallet to ask, so with FlexPrice disabled the gate is off — which is what
 * `npm start` does on a laptop with no `FLEXPRICE_*` in the environment. Setting
 * `BILLING_GATE_POLICY=enforced` while FlexPrice is off is refused at boot rather
 * than silently degrading into a gate that blocks nothing.
 */
function resolveGatePolicy(deps = {}) {
  const explicit = String(deps.gatePolicy === undefined ? CONFIG.BILLING.gatePolicy : deps.gatePolicy)
    .trim().toLowerCase();
  if (explicit === 'off') return { policy: 'off', named: true };
  if (explicit === 'enforced') return { policy: 'enforced', named: true };
  return { policy: CONFIG.FLEXPRICE.enabled ? 'enforced' : 'off', named: false };
}

function reportPolicy({ policy, named }) {
  if (policyReported === policy) return;
  policyReported = policy;
  const line = 'billing_gate_policy';
  const fields = { policy, named: Boolean(named), ttlMs: DEFAULT_TTL_MS };
  // `off` is the case where nothing is enforced, so it is the one that has to say
  // where the decision came from: `BILLING_GATE_POLICY` means an operator chose
  // it, `flexprice_disabled` means the money source is simply not there.
  if (policy === 'off') {
    log.warn(line, { ...fields, because: named ? 'BILLING_GATE_POLICY=off' : 'flexprice_disabled' });
  } else {
    log.info(line, fields);
  }
}

/**
 * Say, at startup, which rule this process will apply.
 *
 * Called from each service's listen callback rather than at require time: a
 * module that logs when imported logs in every test process too. `off` is the
 * line an operator on a laptop is supposed to see — the default follows the
 * money source, so with no FlexPrice configured nothing is enforced, and that
 * has to be stated instead of inferred from the absence of blocks.
 *
 * Refuses `enforced` with no FlexPrice, because that combination is a gate that
 * reads nothing and therefore admits everything. An operator who asked for
 * enforcement must not be handed an open door that logs like a closed one; the
 * alternative (fail open silently) is the failure mode this whole module exists
 * to avoid.
 */
function reportBoot(deps = {}) {
  const { policy, named } = resolveGatePolicy(deps);
  if (policy === 'enforced' && !CONFIG.FLEXPRICE.enabled) {
    throw new Error('gate: BILLING_GATE_POLICY=enforced needs FLEXPRICE_ENABLED=true — with no wallet to read, the gate admits everything');
  }
  reportPolicy({ policy, named });
  return policy;
}

function emptyView(orgId, reason, extra = {}) {
  return {
    orgId,
    state: STATE.unknown,
    reason,
    walletId: null,
    balancePaise: null,
    unpaidInvoicesPaise: null,
    isCachedFallback: false,
    fetchedAt: Date.now(),
    nextAttemptAt: Date.now() + ERROR_RETRY_MS,
    ...extra,
  };
}

function stateForPaise(paise) {
  if (paise > 0) return STATE.available;
  if (paise < 0) return STATE.negative;
  return STATE.exhausted;
}

/** `walletId` for the org's INR prepaid wallet, without creating anything. */
async function resolveWalletId(client, orgId, account) {
  const cached = account && account.flexprice && account.flexprice.walletId;
  if (cached) return cached;
  let customer = null;
  try {
    customer = await client.getCustomerByExternalId(orgId);
  } catch (err) {
    if (err && err.status === 404) return null;
    throw err;
  }
  const customerId = customer && (customer.id || (customer.customer && customer.customer.id));
  if (!customerId) return null;
  const wallets = rowsOf(await client.listWalletsByCustomer(customerId));
  // `currency` answers lower-case from this route, hence the case-insensitive
  // compare; there is normally exactly one wallet per customer.
  const wallet = wallets.find(
    (w) => String(w.currency || '').toUpperCase() === 'INR'
      && String(w.wallet_type || '').toUpperCase() === 'PRE_PAID',
  );
  return wallet && wallet.id ? wallet.id : null;
}

async function fetchView(orgId, deps = {}) {
  const client = deps.client
    || createFlexpriceClient({ config: deps.flexpriceConfig || CONFIG.FLEXPRICE });
  const account = accountFor(orgId, deps);
  const walletId = await resolveWalletId(client, orgId, account);
  if (!walletId) {
    // Not the same as "zero". A recharge or the provisioner creates the wallet,
    // so this is a provisioning state, and blocking on it would take down every
    // org that has not been provisioned yet.
    return emptyView(orgId, 'wallet_missing');
  }
  const balance = await client.walletRealTimeBalance(walletId);
  if (!balance || balance.real_time_credit_balance === undefined) {
    return emptyView(orgId, 'balance_unreadable', { walletId });
  }
  const credits = String(balance.real_time_credit_balance);
  let balancePaise;
  try {
    balancePaise = paiseFromCredits(credits);
  } catch (err) {
    // A balance this code cannot read is a balance it must not spend admission on.
    log.warn('billing_gate_balance_unparsable', { orgId, walletId, credits });
    return emptyView(orgId, 'balance_unparsable', { walletId });
  }
  const paise = (value) => {
    if (value === undefined || value === null || value === '') return null;
    try { return paiseFromCredits(value); } catch { return null; }
  };
  return {
    orgId,
    state: stateForPaise(balancePaise),
    reason: null,
    walletId,
    balancePaise,
    // `current_period_usage` is deliberately NOT carried. It reads "0" on all 21
    // wallets in the local stack — including one a manual debit drove to −2900 —
    // because it is anchored to the current *invoice* cycle, which does not exist
    // until usage invoices are finalized (Phase 5). A field named "period usage"
    // on the admission view would therefore be read as accrued consumption and
    // always read as none, which is the silent version of the bug this whole phase
    // exists to avoid. The meter sum is the usage authority; this view carries the
    // money, nothing else.
    //
    // `unpaid_invoices_amount` is kept on the other hand: it is reported, never
    // subtracted — FlexPrice computes `real_time_credit_balance` from it itself,
    // so taking it off again would bill the same money twice.
    unpaidInvoicesPaise: paise(balance.unpaid_invoices_amount),
    isCachedFallback: Boolean(balance.is_cached_fallback),
    fetchedAt: Date.now(),
    nextAttemptAt: 0,
  };
}

/**
 * Kick a read for one org, at most one at a time. Resolves with the view; never
 * rejects, because the sync caller cannot handle a rejection and the failure has
 * to leave the previous view standing rather than clearing it.
 */
function refresh(orgId, deps = {}) {
  if (inflight.has(orgId)) return inflight.get(orgId);
  const previous = views.get(orgId) || null;
  const promise = fetchView(orgId, deps)
    .then((view) => {
      views.set(orgId, view);
      return view;
    })
    .catch((err) => {
      const message = err && err.message ? err.message : String(err);
      const at = Date.now();
      // Keep the last known number and mark it stale: an outage is not evidence
      // that a solvent org ran out of money, and pretending otherwise turns a
      // FlexPrice blip into an fleet-wide stop.
      views.set(orgId, {
        ...(previous || emptyView(orgId, 'unreadable')),
        orgId,
        stale: true,
        error: message.slice(0, 300),
        fetchedAt: previous ? previous.fetchedAt : at,
        nextAttemptAt: at + ERROR_RETRY_MS,
      });
      log.warn('billing_gate_read_failed', { orgId, holding: Boolean(previous), error: message.slice(0, 200) });
      return views.get(orgId);
    })
    .finally(() => inflight.delete(orgId));
  inflight.set(orgId, promise);
  return promise;
}

function readView(orgId, deps = {}) {
  const now = Date.now();
  const view = views.get(orgId);
  const fresh = view && (now - view.fetchedAt) < ttlMs(deps);
  const cooling = view && view.nextAttemptAt > now;
  if (!fresh && !cooling) {
    // Deliberately not awaited: this is the synchronous admission path.
    void refresh(orgId, deps);
  }
  return views.get(orgId) || null;
}

function shape(orgId, view, { policy, named }) {
  const base = {
    orgId,
    gatePolicy: policy,
    balancePaise: view ? view.balancePaise : null,
    walletId: view ? view.walletId : null,
    state: view ? view.state : STATE.unknown,
    stale: Boolean(view && view.stale),
    isCachedFallback: Boolean(view && view.isCachedFallback),
    sandboxCreationDisabled: false,
    scheduledCallsDisabled: false,
    fundsAvailable: true,
    fundStatus: STATE.available,
    reason: null,
  };
  if (policy === 'off') return base;
  if (!view || view.state === STATE.unknown) {
    if (view && view.reason === 'wallet_missing' && !reportedUnknown.has(`${orgId}:wallet`)) {
      reportedUnknown.add(`${orgId}:wallet`);
      log.warn('billing_gate_wallet_missing', {
        orgId,
        note: 'no INR prepaid wallet in FlexPrice for this org, so its balance is unknown and runs are allowed',
      });
    }
    if (!view && !reportedUnknown.has(orgId)) {
      reportedUnknown.add(orgId);
      log.warn('billing_gate_balance_unread', {
        orgId,
        note: 'the gate is enforced but this process has never read the wallet; first admissions pass until it does',
      });
    }
    return base;
  }
  if (view.state === STATE.available) return base;
  const negative = view.state === STATE.negative;
  return {
    ...base,
    fundsAvailable: false,
    // 'unavailable' is the value every consumer already compares against;
    // 'negative' is new information riding beside it, not a replacement for it.
    fundStatus: negative ? STATE.negative : 'unavailable',
    sandboxCreationDisabled: true,
    scheduledCallsDisabled: true,
    reason: negative
      ? 'Organization credit balance is negative — a platform debit exceeded it. Add credits to resume runner activity.'
      : 'Organization credit balance is exhausted — add credits to resume runner activity.',
  };
}

function accountFor(orgId, deps = {}) {
  if (deps.account !== undefined) return deps.account;
  try {
    return store.getBillingAccount(orgId);
  } catch {
    // A store that cannot answer is not a billing decision. The wallet read that
    // follows is the authority; the account only carries the opt-out and the
    // cached wallet id.
    return null;
  }
}

/**
 * The gate for one org. Synchronous by contract: the value comes from the cache
 * and a stale entry triggers a background refresh.
 *
 * `orgId` may be omitted — the caller's workspace context is then the org, exactly
 * as before. An unresolvable org is not a billing decision, so it passes, which is
 * also what the ~237 colocated stubs around the call sites assume.
 */
function getOrgFundStatus(orgId = null, deps = {}) {
  const resolvedOrgId = typeof orgId === 'string' ? orgId.trim() : resolveOrgId({ orgId });
  const { policy, named } = resolveGatePolicy(deps);
  reportPolicy({ policy, named });

  if (!resolvedOrgId) {
    return { ...shape(null, null, { policy, named }), orgId: null };
  }
  const account = accountFor(resolvedOrgId, deps);
  // The per-org opt-out stays first, and it is the one branch that does not need
  // a balance: an opted-out org must not pay for a read it ignores.
  if (account && account.gateEnabled === false) {
    return { ...shape(resolvedOrgId, views.get(resolvedOrgId) || null, { policy, named }), optedOut: true };
  }
  // `off` costs NOTHING: not a customer lookup, not a balance read. A local
  // profile that boots with FlexPrice unset must not spend a request per
  // admission on a number nobody will look at.
  if (policy !== 'enforced') {
    return shape(resolvedOrgId, views.get(resolvedOrgId) || null, { policy, named });
  }
  // `__shared__` is the free-tier account and has never had a wallet; it is
  // permanently exempt, so it must not even reach the read.
  if (resolvedOrgId === SHARED_ORG_ID) {
    return shape(resolvedOrgId, null, { policy, named });
  }
  return shape(resolvedOrgId, readView(resolvedOrgId, deps), { policy, named });
}

/**
 * The awaiting form, for a caller that can afford the round trip — the billing
 * tick priming the cache, or a UI that wants the number rather than the estimate.
 */
async function ensureFundStatus(orgId = null, deps = {}) {
  const resolvedOrgId = typeof orgId === 'string' ? orgId.trim() : resolveOrgId({ orgId });
  const { policy, named } = resolveGatePolicy(deps);
  reportPolicy({ policy, named });
  if (!resolvedOrgId || policy === 'off' || resolvedOrgId === SHARED_ORG_ID) {
    return getOrgFundStatus(resolvedOrgId, deps);
  }
  const view = await refresh(resolvedOrgId, deps);
  return shape(resolvedOrgId, view, { policy, named });
}

/**
 * Cheap, side-effect-free admission check used at the gateway and again by
 * execution stages.
 */
function billingStatus(context = {}, deps = {}) {
  const orgId = resolveOrgId(context);
  const fundInfo = getOrgFundStatus(orgId, deps);
  const blocked = fundInfo.fundsAvailable === false;
  return {
    blocked,
    orgId,
    gatePolicy: fundInfo.gatePolicy,
    balancePaise: fundInfo.balancePaise,
    fundStatus: fundInfo.fundStatus,
    fundsAvailable: fundInfo.fundsAvailable,
    state: fundInfo.state,
    stale: fundInfo.stale,
    sandboxCreationDisabled: fundInfo.sandboxCreationDisabled,
    scheduledCallsDisabled: fundInfo.scheduledCallsDisabled,
    reason: blocked ? fundInfo.reason : null,
  };
}

function isBillingBlocked(context = {}, deps = {}) {
  return billingStatus(context, deps).blocked;
}

/**
 * Drop what this process believes about one org (or all of them). A recharge
 * calls this: `BILLING_GATE_TTL_MS` worth of "no" after money arrived is correct
 * by the cache's rules and indefensible to the customer.
 */
function invalidate(orgId = null) {
  if (orgId === null) {
    views.clear();
    // A read in flight would repopulate what was just dropped, so an all-orgs
    // reset abandons them rather than racing them.
    inflight.clear();
    reportedUnknown.clear();
    return { cleared: 'all' };
  }
  const key = String(orgId).trim();
  const had = views.delete(key);
  reportedUnknown.delete(key);
  reportedUnknown.delete(`${key}:wallet`);
  return { cleared: key, had };
}

module.exports = {
  STATE,
  DEFAULT_TTL_MS,
  billingStatus,
  isBillingBlocked,
  getOrgFundStatus,
  ensureFundStatus,
  invalidate,
  resolveGatePolicy,
  reportBoot,
  refresh,
};
