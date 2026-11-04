'use strict';

const store = require('../store');
const log = require('../logger');
const { CONFIG } = require('../config');
const ledger = require('./ledger');

// In-process guard: the sweep runs only in the scheduler process and
// never overlaps itself, so debits have a single writer (business-logic: no
// double-processing / double-spend).
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
 *   1. turn usage since the watermark into ONE debit ledger line item per org,
 *   2. refresh each affected org's balance snapshot,
 *   3. advance the watermark and prune granular usage past the retention window.
 *
 * Auto-recharge and threshold alerts deliberately do NOT happen here: this runs
 * on every billing tick (and used to run on every planner tick too), so an
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
    const periodStart = watermark || (records.length ? records[records.length - 1].createdAt : now);

    // 1 + 2: post one aggregated debit per org with usage this window.
    for (const g of groups) {
      try {
        ledger.ensureAccount(g.orgId);
        if (g.costPaise > 0) {
          ledger.postEntry(g.orgId, {
            type: 'usage',
            amountPaise: -g.costPaise,
            description: `LLM usage (${g.count} run${g.count === 1 ? '' : 's'}, ${g.tokens} tokens)`,
            meta: { periodStart, periodEnd: now, tokens: g.tokens, records: g.count },
          });
        } else {
          ledger.refreshBalance(g.orgId); // zero-cost (local) runs still keep the snapshot fresh
        }
      } catch (err) {
        log.warn(`sweep: failed to post usage for org ${g.orgId}: ${err && err.message ? err.message : err}`);
      }
    }

    // 3: advance the watermark.
    store.setBillingState({ lastAggregatedAt: now });

    // 4: retention prune (the ledger itself persists).
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
