'use strict';

const { CONFIG } = require('@ai-fleet/shared-core/config');
const log = require('@ai-fleet/shared-core/logger');
const store = require('@ai-fleet/shared-core/store');
const gate = require('@ai-fleet/shared-core/billing/gate');
const { createFlexpriceClient } = require('@ai-fleet/shared-core/billing/flexprice-client');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHARGE_CREDITS = 3000;

function monthOf(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('platform charge needs a valid date');
  return date.toISOString().slice(0, 7);
}

function keysFor(orgId, month) {
  if (!UUID_RE.test(String(orgId || ''))) throw new TypeError('platform charge needs a UUID org id');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) throw new TypeError('platform charge needs YYYY-MM');
  return {
    invoice: `platform-charge-invoice:${orgId}:${month}`,
    debit: `platform-charge:${orgId}:${month}`,
  };
}

function invoiceSearch(key) {
  return {
    filters: [{
      field: 'idempotency_key',
      operator: 'eq',
      data_type: 'string',
      value: { string: key },
    }],
    limit: 2,
  };
}

function invoiceBody({ orgId, customerId, month }) {
  return {
    customer_id: customerId,
    invoice_type: 'ONE_OFF',
    billing_reason: 'MANUAL',
    invoice_status: 'FINALIZED',
    currency: 'INR',
    subtotal: String(CHARGE_CREDITS),
    total: String(CHARGE_CREDITS),
    amount_due: String(CHARGE_CREDITS),
    line_items: [{
      display_name: `AI Fleet platform charge ${month}`,
      quantity: '1',
      amount: String(CHARGE_CREDITS),
    }],
    metadata: { auto_completed: 'true', fleet_org_id: orgId, billing_month: month },
  };
}

async function findInvoice(client, key) {
  const out = await client.searchInvoices(invoiceSearch(key));
  const rows = out.items || [];
  if (rows.length > 1) throw new Error(`multiple invoices found for idempotency key ${key}`);
  return rows[0] || null;
}

async function ensureInvoice(client, input) {
  const keys = keysFor(input.orgId, input.month);
  const existing = await findInvoice(client, keys.invoice);
  if (existing) return { invoice: existing, created: false };
  if (input.dryRun) return { invoice: null, created: false };
  const created = await client.createInvoice(invoiceBody(input), { idempotencyKey: keys.invoice });
  if (created && created.id) return { invoice: created, created: true };
  if (!created || !created.alreadyExists) throw new Error('FlexPrice accepted no platform-charge invoice id');
  const raced = await findInvoice(client, keys.invoice);
  if (!raced || !raced.id) throw new Error('platform-charge invoice replay could not recover its invoice id');
  return { invoice: raced, created: false };
}

async function findDebit(client, walletId, key) {
  const out = await client.walletTransactionsSearch({
    id: walletId,
    type: 'debit',
    filters: [{
      field: 'idempotency_key',
      operator: 'eq',
      data_type: 'string',
      value: { string: key },
    }],
    limit: 2,
  });
  const rows = out.items || [];
  if (rows.length > 1) throw new Error(`multiple debits found for idempotency key ${key}`);
  return rows[0] || null;
}

async function readBalance(client, walletId) {
  const out = await client.walletRealTimeBalance(walletId);
  const credits = Number(out && out.real_time_credit_balance);
  if (!Number.isFinite(credits)) throw new Error(`wallet ${walletId} returned no readable real_time_credit_balance`);
  return credits;
}

function selectAccounts(storeApi) {
  return storeApi.listBillingAccounts()
    .filter((account) => account && UUID_RE.test(String(account.id || '')))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function chargeAccount(account, options) {
  const { client, month, dryRun, gateApi } = options;
  const orgId = account.id;
  const flexprice = account.flexprice || {};
  if (!flexprice.customerId || !flexprice.walletId) return { orgId, status: 'wallet_unresolved' };
  if (Number(flexprice.conversionRate ?? 1) !== 1) return { orgId, status: 'conversion_rate_mismatch' };

  const keys = keysFor(orgId, month);
  const existingDebit = await findDebit(client, flexprice.walletId, keys.debit);
  if (existingDebit) {
    const invoice = await findInvoice(client, keys.invoice);
    if (!invoice || !invoice.id) throw new Error('platform-charge debit exists without its statement invoice');
    gateApi.invalidate(orgId);
    return { orgId, status: 'already_charged', invoiceId: invoice.id, invoiceCreated: false };
  }

  const balance = await readBalance(client, flexprice.walletId);
  if (balance < CHARGE_CREDITS) return { orgId, status: 'insufficient_balance', balanceCredits: balance };

  const resolved = await ensureInvoice(client, {
    orgId, customerId: flexprice.customerId, month, dryRun,
  });
  if (dryRun) {
    return { orgId, status: resolved.invoice ? 'already_charged_or_pending' : 'due', balanceCredits: balance };
  }

  const latestBalance = await readBalance(client, flexprice.walletId);
  if (latestBalance < CHARGE_CREDITS) {
    return { orgId, status: 'insufficient_balance', balanceCredits: latestBalance, invoiceId: resolved.invoice.id };
  }
  const debit = await client.debitWallet(flexprice.walletId, {
    credits: String(CHARGE_CREDITS),
    idempotencyKey: keys.debit,
    description: `AI Fleet platform charge ${month}`,
    metadata: { invoice_id: resolved.invoice.id },
  });
  gateApi.invalidate(orgId);
  return {
    orgId,
    status: debit && debit.alreadyExists ? 'already_charged' : 'charged',
    invoiceId: resolved.invoice.id,
    invoiceCreated: resolved.created,
    balanceCredits: latestBalance,
  };
}

async function main({
  env = process.env,
  argv = process.argv.slice(2),
  now = new Date(),
  initStoreImpl = store.initStore,
  deps = {},
  logImpl = log,
  write = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const month = String(env.PLATFORM_CHARGE_MONTH || monthOf(now));
  keysFor('00000000-0000-4000-8000-000000000000', month);
  const dryRun = argv.includes('--validate') || ['1', 'true', 'yes', 'on'].includes(String(env.BILLING_JOB_DRY_RUN || '').toLowerCase());
  const resolved = {
    storeApi: deps.storeApi || store,
    client: deps.client || createFlexpriceClient({ config: deps.flexpriceConfig || CONFIG.FLEXPRICE }),
    gateApi: deps.gateApi || gate,
  };
  await initStoreImpl();
  const accounts = selectAccounts(resolved.storeApi);
  const results = [];
  let failed = 0;
  for (const account of accounts) {
    try {
      const result = await chargeAccount(account, { ...resolved, month, dryRun });
      results.push(result);
      if (result.status !== 'charged' && result.status !== 'already_charged') {
        logImpl.warn('platform_charge_skipped', result);
      }
    } catch (err) {
      failed += 1;
      const result = { orgId: account.id, status: 'failed', error: err && err.message ? err.message : String(err) };
      results.push(result);
      logImpl.error('platform_charge_failed', result);
    }
  }
  const summary = {
    month, dryRun, accounts: accounts.length, failed,
    charged: results.filter((r) => r.status === 'charged').length,
    alreadyCharged: results.filter((r) => r.status === 'already_charged').length,
    skipped: results.filter((r) => !['charged', 'already_charged', 'failed'].includes(r.status)).length,
    results,
  };
  write(JSON.stringify(summary));
  return summary;
}

if (require.main === module) void main().catch((err) => {
  log.error('platform_charge_job_failed', { error: err && err.message ? err.message : String(err) });
  process.exitCode = 1;
});

module.exports = {
  CHARGE_CREDITS,
  monthOf,
  keysFor,
  invoiceSearch,
  invoiceBody,
  findInvoice,
  ensureInvoice,
  findDebit,
  readBalance,
  selectAccounts,
  chargeAccount,
  main,
};
