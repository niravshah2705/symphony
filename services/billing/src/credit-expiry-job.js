'use strict';

const { CONFIG } = require('@ai-fleet/shared-core/config');
const log = require('@ai-fleet/shared-core/logger');
const store = require('@ai-fleet/shared-core/store');
const {
  createFlexpriceClient,
  rowsOf,
} = require('@ai-fleet/shared-core/billing/flexprice-client');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_GRACE_MS = 3 * 60 * 60 * 1000;
const DEFAULT_SEARCH_LIMIT = 100;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_REPORT_LIMIT = 20;
const MAX_REPORT_LIMIT = 100;

function validDate(value, label = 'now') {
  if (value === null || value === undefined || value === '') {
    throw new TypeError(`credit expiry ${label} must be a valid date`);
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`credit expiry ${label} must be a valid date`);
  return date;
}

function nonNegativeMs(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new TypeError('credit expiry grace must be a non-negative number of milliseconds');
  }
  const graceMs = Number(value);
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new TypeError('credit expiry grace must be a non-negative number of milliseconds');
  }
  return graceMs;
}

function boundedLimit(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(maximum, Math.floor(parsed));
}

function selectAccounts(storeApi) {
  return storeApi.listBillingAccounts()
    .filter((account) => account && UUID_RE.test(String(account.id || '')))
    .filter((account) => String(account.flexprice && account.flexprice.walletId || '').trim())
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function pendingRows(payload, cutoff, reportLimit = DEFAULT_REPORT_LIMIT) {
  const pending = [];
  for (const row of rowsOf(payload)) {
    const available = Number(row && row.credits_available);
    if (!Number.isFinite(available) || available <= 0) continue;
    let expiry;
    try {
      expiry = validDate(row.expiry_date, 'row expiry_date');
    } catch (_) {
      continue;
    }
    if (expiry.getTime() >= cutoff.getTime()) continue;
    pending.push({
      transactionId: row.id || null,
      creditsAvailable: String(row.credits_available),
      expiryDate: expiry.toISOString(),
    });
  }
  return {
    count: pending.length,
    rows: pending.slice(0, reportLimit),
    truncated: Math.max(0, pending.length - reportLimit),
  };
}

async function inspectAccount(account, options) {
  const walletId = String(account.flexprice.walletId).trim();
  const response = await options.client.walletTransactionsSearch({
    id: walletId,
    type: 'credit',
    credits_available_gt: '0',
    expiry_date_before: options.now.toISOString(),
    limit: options.searchLimit,
  });
  const limited = { items: rowsOf(response).slice(0, options.searchLimit) };
  const pending = pendingRows(limited, options.cutoff, options.reportLimit);
  return {
    orgId: account.id,
    walletId,
    rowsInspected: limited.items.length,
    pendingMaterialization: pending.count,
    rows: pending.rows,
    truncated: pending.truncated,
  };
}

async function main({
  env = process.env,
  now = new Date(),
  graceMs,
  searchLimit,
  reportLimit,
  initStoreImpl = store.initStore,
  deps = {},
  logImpl = log,
  write = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const resolvedNow = validDate(typeof now === 'function' ? now() : now);
  const resolvedGraceMs = nonNegativeMs(
    graceMs ?? deps.graceMs ?? env.CREDIT_EXPIRY_GRACE_MS ?? DEFAULT_GRACE_MS,
  );
  const resolvedSearchLimit = boundedLimit(
    searchLimit ?? deps.searchLimit ?? env.CREDIT_EXPIRY_SEARCH_LIMIT,
    DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
  );
  const resolvedReportLimit = boundedLimit(
    reportLimit ?? deps.reportLimit ?? env.CREDIT_EXPIRY_REPORT_LIMIT,
    DEFAULT_REPORT_LIMIT,
    MAX_REPORT_LIMIT,
  );
  const resolved = {
    storeApi: deps.storeApi || store,
    client: deps.client || createFlexpriceClient({ config: deps.flexpriceConfig || CONFIG.FLEXPRICE }),
  };

  await initStoreImpl();
  const accounts = selectAccounts(resolved.storeApi);
  const cutoff = new Date(resolvedNow.getTime() - resolvedGraceMs);
  const results = [];
  let failed = 0;
  let pendingMaterialization = 0;

  for (const account of accounts) {
    try {
      const result = await inspectAccount(account, {
        client: resolved.client,
        now: resolvedNow,
        cutoff,
        searchLimit: resolvedSearchLimit,
        reportLimit: resolvedReportLimit,
      });
      results.push(result);
      pendingMaterialization += result.pendingMaterialization;
      if (result.pendingMaterialization > 0) {
        logImpl.warn('credit_expiry_pending_temporal_materialization', result);
      }
    } catch (err) {
      failed += 1;
      const result = {
        orgId: account.id,
        walletId: account.flexprice.walletId,
        status: 'failed',
        error: err && err.message ? err.message : String(err),
      };
      results.push(result);
      logImpl.error('credit_expiry_check_failed', result);
    }
  }

  const summary = {
    now: resolvedNow.toISOString(),
    graceMs: resolvedGraceMs,
    searchLimit: resolvedSearchLimit,
    accounts: accounts.length,
    failed,
    pendingMaterialization,
    results,
  };
  write(JSON.stringify(summary));
  return summary;
}

if (require.main === module) void main().catch((err) => {
  log.error('credit_expiry_job_failed', { error: err && err.message ? err.message : String(err) });
  process.exitCode = 1;
});

module.exports = {
  UUID_RE,
  DEFAULT_GRACE_MS,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  validDate,
  nonNegativeMs,
  boundedLimit,
  selectAccounts,
  pendingRows,
  inspectAccount,
  main,
};
