'use strict';

const store = require('../store');
const { CONFIG } = require('../config');

// In-process guard: the sweep runs only in the scheduler process and never
// overlaps itself, so the watermark advances once per pass.
let sweeping = false;

/** Group usage records by orgId, summing paise + tokens. */
function aggregateByOrg(records) {
  const byOrg = new Map();
  for (const r of records) {
    const orgId = r.orgId || '__shared__';
    const acc = byOrg.get(orgId) || { orgId, costPaise: 0, tokens: 0, count: 0 };
    acc.costPaise += Number(r.costPaise) || 0;
    acc.tokens += (r.usage && Number(r.usage.totalTokens)) || 0;
    acc.count += 1;
    byOrg.set(orgId, acc);
  }
  return [...byOrg.values()];
}

/**
 * One billing sweep:
 *   1. report the usage accumulated since the watermark, per org,
 *   2. advance the watermark and prune granular usage past the retention window.
 *
 * It moves no money. Every org's usage was already handed to the FlexPrice
 * ingest API by the outbox drain (`billing/outbox-drain.js`), which is the only
 * delivery-proofed path, and the balance that admission decisions read is the
 * wallet's. This sweep used to post one aggregated debit per org into the local
 * ledger — a second copy of the same spend that could and did disagree with the
 * wallet, since a notional (customer-key) run posted a debit here while FlexPrice
 * saw nothing. `usageRecords` still feeds the outbox and the Usage page, and the
 * watermark and the retention prune are still this function's job.
 *
 * Auto-recharge and threshold alerts deliberately do NOT happen here either: this
 * runs on every billing tick (and used to run on every planner tick too), so an
 * all-accounts money path inside it re-charged orgs far below the intended
 * cadence. That work lives in the scheduled auto-recharge job
 * (services/billing/src/auto-recharge-job.js), which validates before charging.
 * Serialized (never overlaps) and fail-open per org. Returns a summary.
 */
async function processBillingSweep(deps = {}) {
  if (!CONFIG.BILLING.sweepEnabled) return { skipped: 'disabled' };
  if (sweeping) return { skipped: 'already-running' };
  sweeping = true;
  try {
    const now = deps.now || new Date().toISOString();
    const watermark = store.getBillingState().lastAggregatedAt || '';
    const records = store
      .listUsageRecords()
      .filter((r) => String(r.createdAt || '') > watermark && String(r.createdAt || '') <= now);
    const groups = aggregateByOrg(records);

    store.setBillingState({ lastAggregatedAt: now });

    // Retention prune (the usage records themselves; the outbox has its own lifecycle).
    const retentionMs = CONFIG.BILLING.usageRetentionDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date((deps.nowMs || Date.now()) - retentionMs).toISOString();
    const pruned = store.pruneUsageRecords(cutoff);

    return {
      aggregatedOrgs: groups.length,
      recordsProcessed: records.length,
      pruned,
      watermark: now,
    };
  } finally {
    sweeping = false;
  }
}

module.exports = {
  aggregateByOrg,
  processBillingSweep,
};
